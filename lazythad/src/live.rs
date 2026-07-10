//! Background refresh worker for the interactive terminal UI.

use std::sync::mpsc;
use std::thread;

use anyhow::Result;

use crate::client::{Pull, Release, Remote};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RefreshTarget {
    pub repo: Option<String>,
    pub view: String,
}

#[derive(Debug, Clone)]
pub struct RefreshSnapshot {
    pub repos: Vec<String>,
    pub repo: Option<String>,
    pub pull: Pull,
    pub releases: Vec<Release>,
}

#[derive(Debug, Clone)]
pub struct RefreshMessage {
    pub target: RefreshTarget,
    pub result: Result<RefreshSnapshot, String>,
}

trait RefreshSource: Send + 'static {
    fn fetch(&mut self, target: &RefreshTarget) -> Result<RefreshSnapshot, String>;
}

/// Load a coherent remote snapshot for the requested repo and view.
fn fetch_snapshot(remote: &Remote, target: &RefreshTarget) -> Result<RefreshSnapshot> {
    let mut repos = remote.repos()?;
    repos.sort();
    let repo = target
        .repo
        .as_ref()
        .filter(|name| repos.contains(name))
        .cloned()
        .or_else(|| repos.first().cloned());
    let (pull, releases) = match &repo {
        Some(name) => (remote.pull(name, &target.view)?, remote.releases(name)?),
        None => (Pull::default(), Vec::new()),
    };
    Ok(RefreshSnapshot {
        repos,
        repo,
        pull,
        releases,
    })
}

impl RefreshSource for Remote {
    fn fetch(&mut self, target: &RefreshTarget) -> Result<RefreshSnapshot, String> {
        fetch_snapshot(self, target).map_err(|error| error.to_string())
    }
}

/// Owns one background worker and coalesces refreshes while it is busy.
pub struct LiveRefresh {
    requests: mpsc::Sender<RefreshTarget>,
    results: mpsc::Receiver<RefreshMessage>,
    in_flight: bool,
    active: Option<RefreshTarget>,
    pending: Option<RefreshTarget>,
    disconnected: bool,
}

impl LiveRefresh {
    pub fn new(remote: Remote) -> Self {
        Self::with_source(remote)
    }

    fn with_source<S: RefreshSource>(mut source: S) -> Self {
        let (request_tx, request_rx) = mpsc::channel::<RefreshTarget>();
        let (result_tx, result_rx) = mpsc::channel::<RefreshMessage>();
        thread::spawn(move || {
            while let Ok(target) = request_rx.recv() {
                let result = source.fetch(&target);
                if result_tx.send(RefreshMessage { target, result }).is_err() {
                    break;
                }
            }
        });
        Self {
            requests: request_tx,
            results: result_rx,
            in_flight: false,
            active: None,
            pending: None,
            disconnected: false,
        }
    }

    /// Submit immediately when idle, otherwise retain only the newest target.
    pub fn request(&mut self, target: RefreshTarget) -> bool {
        if self.in_flight {
            self.pending = Some(target);
            return false;
        }
        if self.requests.send(target.clone()).is_err() {
            self.disconnected = true;
            return false;
        }
        self.in_flight = true;
        self.active = Some(target);
        true
    }

    /// Poll without waiting and start any coalesced request after a completion.
    pub fn try_recv(&mut self) -> Option<RefreshMessage> {
        match self.results.try_recv() {
            Ok(message) => {
                self.in_flight = false;
                self.active = None;
                if let Some(target) = self.pending.take() {
                    self.request(target);
                }
                Some(message)
            }
            Err(mpsc::TryRecvError::Empty) => None,
            Err(mpsc::TryRecvError::Disconnected) if !self.disconnected => {
                self.disconnected = true;
                self.in_flight = false;
                Some(RefreshMessage {
                    target: self
                        .active
                        .take()
                        .or_else(|| self.pending.take())
                        .unwrap_or(RefreshTarget {
                            repo: None,
                            view: "main".into(),
                        }),
                    result: Err("live refresh worker disconnected".into()),
                })
            }
            Err(mpsc::TryRecvError::Disconnected) => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::client::Pull;
    use std::sync::mpsc;
    use std::thread;
    use std::time::{Duration, Instant};

    struct BlockingSource {
        started: mpsc::Sender<RefreshTarget>,
        release: mpsc::Receiver<()>,
    }

    impl RefreshSource for BlockingSource {
        fn fetch(&mut self, target: &RefreshTarget) -> Result<RefreshSnapshot, String> {
            self.started.send(target.clone()).unwrap();
            self.release.recv().unwrap();
            Ok(RefreshSnapshot {
                repos: target.repo.clone().into_iter().collect(),
                repo: target.repo.clone(),
                pull: Pull::default(),
                releases: Vec::new(),
            })
        }
    }

    #[test]
    fn coalesces_while_busy_and_try_recv_never_waits() {
        let (started_tx, started_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let mut live = LiveRefresh::with_source(BlockingSource {
            started: started_tx,
            release: release_rx,
        });
        let target = |repo: &str| RefreshTarget {
            repo: Some(repo.into()),
            view: "main".into(),
        };

        assert!(live.request(target("one")));
        assert_eq!(
            started_rx.recv_timeout(Duration::from_secs(1)).unwrap(),
            target("one")
        );
        assert!(!live.request(target("two")));
        assert!(!live.request(target("three")));

        assert!(live.try_recv().is_none());

        release_tx.send(()).unwrap();
        let deadline = Instant::now() + Duration::from_secs(1);
        while live.try_recv().is_none() && Instant::now() < deadline {
            thread::yield_now();
        }
        assert_eq!(
            started_rx.recv_timeout(Duration::from_secs(1)).unwrap(),
            target("three")
        );
        release_tx.send(()).unwrap();
    }

    #[test]
    fn reports_a_result_channel_disconnect_once() {
        let (request_tx, _request_rx) = mpsc::channel();
        let (result_tx, result_rx) = mpsc::channel();
        drop(result_tx);
        let target = RefreshTarget {
            repo: Some("acme/web".into()),
            view: "main".into(),
        };
        let mut live = LiveRefresh {
            requests: request_tx,
            results: result_rx,
            in_flight: true,
            active: Some(target.clone()),
            pending: None,
            disconnected: false,
        };

        let message = live.try_recv().expect("disconnect message");
        assert_eq!(message.target, target);
        assert_eq!(
            message.result.unwrap_err(),
            "live refresh worker disconnected"
        );
        assert!(live.try_recv().is_none());
    }
}
