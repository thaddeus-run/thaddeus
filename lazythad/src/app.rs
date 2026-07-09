//! The `lazythad` application state and the transitions the key handler drives.
//! Kept free of terminal I/O so the navigation logic is unit-testable.

use ratatui::crossterm::event::{KeyCode, KeyEvent};

use crate::client::{Op, Pull, Release, Remote, Reputation};

/// The activity shown in the middle and detail panes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Activity {
    Log,
    Releases,
}

/// Which pane has the keyboard.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Focus {
    Repos,
    Log,
}

pub struct App {
    pub remote: Remote,
    pub server_label: String,
    pub repos: Vec<String>,
    pub repo_sel: usize,
    pub view: String,
    pub pull: Pull,
    pub op_sel: usize,
    pub releases: Vec<Release>,
    pub release_sel: usize,
    pub activity: Activity,
    pub focus: Focus,
    pub status: String,
    /// When `Some`, a reputation overlay is shown for a DID.
    pub reputation: Option<Reputation>,
    pub should_quit: bool,
}

impl App {
    /// Build an app and load the remote's repos (+ the first repo's log). A
    /// failure is surfaced in the status line rather than aborting startup.
    pub fn new(remote: Remote, server_label: String) -> Self {
        let mut app = App {
            remote,
            server_label,
            repos: Vec::new(),
            repo_sel: 0,
            view: "main".to_string(),
            pull: Pull::default(),
            op_sel: 0,
            releases: Vec::new(),
            release_sel: 0,
            activity: Activity::Log,
            focus: Focus::Repos,
            status: String::new(),
            reputation: None,
            should_quit: false,
        };
        app.refresh();
        app
    }

    /// Re-fetch the repo list and reload the selected repo's log.
    pub fn refresh(&mut self) {
        match self.remote.repos() {
            Ok(repos) => {
                self.repos = repos;
                if self.repo_sel >= self.repos.len() {
                    self.repo_sel = self.repos.len().saturating_sub(1);
                }
                self.load_selected_repo();
            }
            Err(e) => self.status = format!("error listing repos: {e}"),
        }
    }

    /// Pull the selected repo's current view and immutable releases together.
    pub fn load_selected_repo(&mut self) {
        self.op_sel = 0;
        self.release_sel = 0;
        self.reputation = None;
        let Some(repo) = self.repos.get(self.repo_sel).cloned() else {
            self.pull = Pull::default();
            self.releases.clear();
            return;
        };
        let pull = self.remote.pull(&repo, &self.view);
        let releases = self.remote.releases(&repo);
        match (pull, releases) {
            (Ok(pull), Ok(releases)) => {
                self.status = format!(
                    "{}  ·  {} op(s)  ·  {} release(s)  ·  {} head(s)",
                    repo,
                    pull.ops.len(),
                    releases.len(),
                    pull.heads.len()
                );
                self.pull = pull;
                self.releases = releases;
            }
            (Err(e), Ok(releases)) => {
                self.pull = Pull::default();
                self.releases = releases;
                self.status = format!("error pulling {repo}: {e}");
            }
            (Ok(pull), Err(e)) => {
                self.pull = pull;
                self.releases.clear();
                self.status = format!("error loading releases for {repo}: {e}");
            }
            (Err(pull_error), Err(release_error)) => {
                self.pull = Pull::default();
                self.releases.clear();
                self.status =
                    format!("error loading {repo}: pull: {pull_error}; releases: {release_error}");
            }
        }
    }

    pub fn selected_op(&self) -> Option<&Op> {
        self.pull.ops.get(self.op_sel)
    }

    pub fn selected_release(&self) -> Option<&Release> {
        self.releases.get(self.release_sel)
    }

    // Moving the cursor is pure state; `on_key` decides whether a move in the
    // Repos pane should also (blockingly) reload that repo's log. Keeping the
    // network out of here keeps the navigation unit-tests offline.
    fn move_down(&mut self) {
        match self.focus {
            Focus::Repos => {
                if self.repo_sel + 1 < self.repos.len() {
                    self.repo_sel += 1;
                }
            }
            Focus::Log => match self.activity {
                Activity::Log if self.op_sel + 1 < self.pull.ops.len() => {
                    self.op_sel += 1;
                }
                Activity::Releases if self.release_sel + 1 < self.releases.len() => {
                    self.release_sel += 1;
                }
                _ => {}
            },
        }
    }

    fn move_up(&mut self) {
        match self.focus {
            Focus::Repos => {
                self.repo_sel = self.repo_sel.saturating_sub(1);
            }
            Focus::Log => match self.activity {
                Activity::Log => self.op_sel = self.op_sel.saturating_sub(1),
                Activity::Releases => self.release_sel = self.release_sel.saturating_sub(1),
            },
        }
    }

    /// Fetch and show the reputation of the selected op's author.
    fn show_reputation(&mut self) {
        if self.activity != Activity::Log {
            return;
        }
        let Some(author) = self.selected_op().map(|o| o.author.clone()) else {
            return;
        };
        match self.remote.reputation(&author) {
            Ok(rep) => self.reputation = Some(rep),
            Err(e) => self.status = format!("error fetching reputation: {e}"),
        }
    }

    /// Drive one key press. Esc closes an open overlay first; otherwise keys map
    /// to navigation/actions.
    pub fn on_key(&mut self, key: KeyEvent) {
        if self.reputation.is_some() {
            // The overlay is modal: q/Esc still quit (matching the documented
            // keys), any other key just dismisses it.
            match key.code {
                KeyCode::Char('q') | KeyCode::Esc => self.should_quit = true,
                _ => self.reputation = None,
            }
            return;
        }
        match key.code {
            KeyCode::Char('q') | KeyCode::Esc => self.should_quit = true,
            KeyCode::Tab | KeyCode::Char('\t') => {
                self.focus = match self.focus {
                    Focus::Repos => Focus::Log,
                    Focus::Log => Focus::Repos,
                };
            }
            // The log follows the repos cursor, so arrowing the list shows each
            // repo's log without an extra keypress. Only reload when the cursor
            // actually moved — at a list boundary the selection is unchanged and
            // a refetch would just freeze the UI on the same repo. The pull is
            // blocking; a debounce (then a background fetch) is the fast-follow.
            KeyCode::Down | KeyCode::Char('j') => {
                let prev = self.repo_sel;
                self.move_down();
                if self.focus == Focus::Repos && self.repo_sel != prev {
                    self.load_selected_repo();
                }
            }
            KeyCode::Up | KeyCode::Char('k') => {
                let prev = self.repo_sel;
                self.move_up();
                if self.focus == Focus::Repos && self.repo_sel != prev {
                    self.load_selected_repo();
                }
            }
            // Enter on the repos pane loads that repo's log and focuses it.
            KeyCode::Enter | KeyCode::Char('l') if self.focus == Focus::Repos => {
                self.load_selected_repo();
                self.focus = Focus::Log;
            }
            KeyCode::Char('r') => self.refresh(),
            KeyCode::Char('R') => self.show_reputation(),
            KeyCode::Char('t') => {
                self.activity = match self.activity {
                    Activity::Log => Activity::Releases,
                    Activity::Releases => Activity::Log,
                };
            }
            _ => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::client::{Op, Release};
    use std::collections::HashMap;

    fn op(id: &str, lamport: i64) -> Op {
        Op {
            id: id.to_string(),
            path: "a.rs".into(),
            at: "t".into(),
            author: "did:key:zA".into(),
            lamport,
        }
    }

    fn release(tag: &str) -> Release {
        Release {
            tag: tag.into(),
            view: "main".into(),
            at: "2026-07-09T12:00:00.000Z".into(),
            heads: vec![],
            commits: vec![],
            notes: None,
            artifacts: vec![],
            id: format!("id-{tag}"),
            signed_by: "did:key:zA".into(),
        }
    }

    /// Build an app with fixed state and no network, for navigation tests.
    fn fixture() -> App {
        App {
            remote: Remote::new("http://unused"),
            server_label: "unused".into(),
            repos: vec!["acme/web".into(), "acme/api".into()],
            repo_sel: 0,
            view: "main".into(),
            pull: Pull {
                heads: vec![],
                ops: vec![op("op2", 2), op("op1", 1)],
                prov: HashMap::new(),
                veto: HashMap::new(),
            },
            op_sel: 0,
            releases: Vec::new(),
            release_sel: 0,
            activity: Activity::Log,
            focus: Focus::Log,
            status: String::new(),
            reputation: None,
            should_quit: false,
        }
    }

    fn key(code: KeyCode) -> KeyEvent {
        KeyEvent::from(code)
    }

    #[test]
    fn j_and_k_move_the_log_selection_within_bounds() {
        let mut app = fixture();
        assert_eq!(app.op_sel, 0);
        app.on_key(key(KeyCode::Char('j')));
        assert_eq!(app.op_sel, 1);
        app.on_key(key(KeyCode::Char('j'))); // clamped at the last op
        assert_eq!(app.op_sel, 1);
        app.on_key(key(KeyCode::Char('k')));
        assert_eq!(app.op_sel, 0);
        app.on_key(key(KeyCode::Char('k'))); // clamped at the first op
        assert_eq!(app.op_sel, 0);
    }

    #[test]
    fn tab_toggles_focus_and_q_quits() {
        let mut app = fixture();
        app.focus = Focus::Repos;
        app.on_key(key(KeyCode::Tab));
        assert_eq!(app.focus, Focus::Log);
        app.on_key(key(KeyCode::Char('q')));
        assert!(app.should_quit);
    }

    #[test]
    fn t_toggles_between_log_and_releases() {
        let mut app = fixture();
        assert_eq!(app.activity, Activity::Log);
        app.on_key(key(KeyCode::Char('t')));
        assert_eq!(app.activity, Activity::Releases);
        app.on_key(key(KeyCode::Char('t')));
        assert_eq!(app.activity, Activity::Log);
    }

    #[test]
    fn overlay_dismisses_on_any_key_but_q_still_quits() {
        let mut app = fixture();
        app.reputation = Some(Reputation::default());
        app.on_key(key(KeyCode::Char('j'))); // a non-quit key only dismisses
        assert!(app.reputation.is_none());
        assert!(!app.should_quit);

        app.reputation = Some(Reputation::default());
        app.on_key(key(KeyCode::Char('q'))); // q quits even from the overlay
        assert!(app.should_quit);
    }

    #[test]
    fn selected_op_follows_the_cursor() {
        let mut app = fixture();
        assert_eq!(app.selected_op().unwrap().id, "op2");
        app.on_key(key(KeyCode::Down));
        assert_eq!(app.selected_op().unwrap().id, "op1");
    }

    #[test]
    fn release_mode_moves_its_own_selection() {
        let mut app = fixture();
        app.activity = Activity::Releases;
        app.releases = vec![release("v2"), release("v1")];
        app.on_key(key(KeyCode::Down));
        assert_eq!(app.selected_release().unwrap().tag, "v1");
        assert_eq!(app.op_sel, 0);
    }
}
