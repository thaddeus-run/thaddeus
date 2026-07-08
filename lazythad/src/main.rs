//! `lazythad` — a lazygit-style terminal UI for Thaddeus. Read-mostly: browse a
//! remote's repos, the op log, the signed why, vetoes, and reputation over the
//! untrusted HTTP mirror (no keys, no decryption).

mod app;
mod client;
mod ui;

use std::io::{self, Stdout};
use std::time::Duration;

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

const DEFAULT_SERVER: &str = "http://localhost:4000";

fn print_help() {
    println!(
        "lazythad — a terminal UI for Thaddeus\n\n\
         Usage: lazythad [server]        (default {DEFAULT_SERVER})\n\
         \x20      lazythad --dump [server]   print repos + logs as text (no TTY)\n\n\
         Keys:\n\
         \x20 q / Esc   quit\n\
         \x20 Tab       switch pane (repos ↔ log)\n\
         \x20 j / k     move selection (↑/↓ also)\n\
         \x20 Enter     open the selected repo's log\n\
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
            let server = args
                .get(1)
                .cloned()
                .unwrap_or_else(|| DEFAULT_SERVER.to_string());
            return dump(&Remote::new(&server));
        }
        _ => {}
    }

    let server = args
        .into_iter()
        .next()
        .unwrap_or_else(|| DEFAULT_SERVER.to_string());
    let mut app = App::new(Remote::new(&server), server.clone());

    let mut terminal = setup_terminal()?;
    let result = run(&mut terminal, &mut app);
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

fn run(terminal: &mut Terminal<CrosstermBackend<Stdout>>, app: &mut App) -> Result<()> {
    loop {
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
