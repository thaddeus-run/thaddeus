//! `lazythad` — a lazygit-style terminal UI for Thaddeus. Read-mostly: browse a
//! remote's repos, op log, releases, signed why, vetoes, and reputation over
//! the untrusted HTTP mirror, plus decryption-bounded local queries delegated
//! to the `thaddeus` CLI inside a matching working copy.

mod app;
mod client;
mod live;
mod query;
mod ui;

use std::io::{self, Stdout};
use std::time::{Duration, Instant};

use anyhow::Result;
use ratatui::backend::CrosstermBackend;
use ratatui::crossterm::event::{self, Event, KeyEventKind};
use ratatui::crossterm::execute;
use ratatui::crossterm::terminal::{
    disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen,
};
use ratatui::Terminal;

use app::App;
use client::Remote;
use live::LiveRefresh;
use query::{LocalQueries, QuerySource};

const DEFAULT_SERVER: &str = "http://localhost:4000";

/// The server to browse when none is given on the command line: the CLI's saved
/// default (`thaddeus use`), else the local default. This lets
/// `thaddeus use --hosted` point lazythad at the same server as the CLI.
fn default_server() -> String {
    config_default_server().unwrap_or_else(|| DEFAULT_SERVER.to_string())
}

/// Read `defaultServer` from the CLI's global config file
/// (`~/.config/thaddeus/config.json`, matching the CLI's home resolution — HOME,
/// or USERPROFILE on Windows). A missing file or parse error yields None.
fn config_default_server() -> Option<String> {
    let home = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE"))?;
    let path = std::path::Path::new(&home)
        .join(".config")
        .join("thaddeus")
        .join("config.json");
    let text = std::fs::read_to_string(path).ok()?;
    let cfg: serde_json::Value = serde_json::from_str(&text).ok()?;
    cfg.get("defaultServer")?.as_str().map(str::to_string)
}

fn print_help() {
    println!(
        "lazythad — a terminal UI for Thaddeus\n\n\
         Usage: lazythad [server]        (default: your 'thaddeus use' server, else {DEFAULT_SERVER})\n\
         \x20      lazythad --dump [server]   print repos + logs as text (no TTY)\n\n\
         Keys:\n\
         \x20 q / Esc   quit\n\
         \x20 Tab       switch pane (repos ↔ activity)\n\
         \x20 j / k     move selection (↑/↓ also)\n\
         \x20 Enter     open the selected repo's log\n\
         \x20 t         toggle log / releases\n\
         \x20 /         query the matching local committed working copy\n\
         \x20 r         refresh from the remote\n\
         \x20 R         reputation of the selected op's author"
    );
}

/// Headless text dump of every repo's `main` log — the non-TTY companion to the
/// browse UI, and a scriptable view of the same data the panes show.
fn dump(remote: &Remote) -> Result<()> {
    let repos = remote.repos()?;
    if repos.is_empty() {
        println!("(no repos)");
        return Ok(());
    }
    for repo in &repos {
        let pull = remote.pull(repo, "main")?;
        println!(
            "{}  ({} op(s), {} head(s))",
            repo,
            pull.ops.len(),
            pull.heads.len()
        );
        for op in &pull.ops {
            let id: String = op.id.chars().take(10).collect();
            let vetoed = pull.veto.get(&op.id).is_some_and(|v| !v.is_empty());
            let why = pull
                .prov
                .get(&op.id)
                .and_then(|records| records.first())
                .map(|p| p.intent.as_str())
                .unwrap_or("");
            let mut line = format!("  {}  {}  {}", id, op.at, op.path);
            if vetoed {
                line.push_str("  ⛔");
            }
            if !why.is_empty() {
                line.push_str(&format!("  — {why}"));
            }
            println!("{line}");
        }
    }
    Ok(())
}

fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("--version") | Some("-v") => {
            println!("{}", env!("CARGO_PKG_VERSION"));
            return Ok(());
        }
        Some("--help") | Some("-h") => {
            print_help();
            return Ok(());
        }
        // Headless: print repos + logs as text (no TTY) — scriptable, and the
        // path an integration/CI check can drive without a terminal.
        Some("--dump") => {
            let server = args.get(1).cloned().unwrap_or_else(default_server);
            return dump(&Remote::new(&server));
        }
        _ => {}
    }

    let server = args.into_iter().next().unwrap_or_else(default_server);
    let local_queries = std::env::current_dir()
        .ok()
        .and_then(|cwd| LocalQueries::discover(&cwd).ok().flatten())
        .map(|source| Box::new(source) as Box<dyn QuerySource>);
    let remote = Remote::new(&server);
    let mut app = App::new(remote.clone(), server.clone(), local_queries);
    let mut live = LiveRefresh::new(remote);

    let mut terminal = setup_terminal()?;
    let result = run(&mut terminal, &mut app, &mut live);
    // Always restore the terminal, even if the loop errored.
    restore_terminal(&mut terminal)?;
    result
}

fn setup_terminal() -> Result<Terminal<CrosstermBackend<Stdout>>> {
    enable_raw_mode()?;
    let mut stdout = io::stdout();
    execute!(stdout, EnterAlternateScreen)?;
    Ok(Terminal::new(CrosstermBackend::new(stdout))?)
}

fn restore_terminal(terminal: &mut Terminal<CrosstermBackend<Stdout>>) -> Result<()> {
    disable_raw_mode()?;
    execute!(terminal.backend_mut(), LeaveAlternateScreen)?;
    terminal.show_cursor()?;
    Ok(())
}

fn run(
    terminal: &mut Terminal<CrosstermBackend<Stdout>>,
    app: &mut App,
    live: &mut LiveRefresh,
) -> Result<()> {
    let mut next_refresh = Instant::now() + Duration::from_secs(2);
    loop {
        while let Some(message) = live.try_recv() {
            app.apply_refresh(message);
        }
        if app.take_refresh_request() || Instant::now() >= next_refresh {
            live.request(app.refresh_target());
            next_refresh = Instant::now() + Duration::from_secs(2);
        }
        terminal.draw(|frame| ui::render(frame, app))?;
        // Poll so the UI stays responsive; only handle key PRESS events (some
        // terminals also emit Release/Repeat, which would double-fire actions).
        if event::poll(Duration::from_millis(200))? {
            if let Event::Key(key) = event::read()? {
                if key.kind == KeyEventKind::Press {
                    app.on_key(key);
                }
            }
        }
        if app.should_quit {
            return Ok(());
        }
    }
}
