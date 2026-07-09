//! Rendering for `lazythad`: a three-pane browse layout (repos · log · detail)
//! with a status/hint bar and an optional reputation overlay.

use ratatui::layout::{Constraint, Flex, Layout, Rect};
use ratatui::style::{Color, Modifier, Style, Stylize};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Clear, List, ListItem, ListState, Paragraph, Wrap};
use ratatui::Frame;

use crate::app::{Activity, App, Focus};
use crate::client::Reputation;

const ACCENT: Color = Color::Cyan;

fn pane_block(title: &str, focused: bool) -> Block<'_> {
    let border = if focused {
        Style::new().fg(ACCENT).add_modifier(Modifier::BOLD)
    } else {
        Style::new().fg(Color::DarkGray)
    };
    Block::bordered()
        .title(title.to_string())
        .border_style(border)
}

fn selected_style() -> Style {
    Style::new()
        .bg(ACCENT)
        .fg(Color::Black)
        .add_modifier(Modifier::BOLD)
}

/// Draw the whole frame.
pub fn render(frame: &mut Frame, app: &App) {
    let root = Layout::vertical([Constraint::Min(1), Constraint::Length(1)]).split(frame.area());
    let panes = Layout::horizontal([
        Constraint::Percentage(26),
        Constraint::Percentage(42),
        Constraint::Percentage(32),
    ])
    .split(root[0]);

    render_repos(frame, app, panes[0]);
    render_activity(frame, app, panes[1]);
    render_detail(frame, app, panes[2]);
    render_status(frame, app, root[1]);

    if let Some(rep) = &app.reputation {
        render_reputation(frame, rep, frame.area());
    }
}

fn render_repos(frame: &mut Frame, app: &App, area: Rect) {
    let items: Vec<ListItem> = app
        .repos
        .iter()
        .map(|r| ListItem::new(r.as_str()))
        .collect();
    let list = List::new(items)
        .block(pane_block("Repos", app.focus == Focus::Repos))
        .highlight_style(selected_style())
        .highlight_symbol("▌ ");
    let mut state = ListState::default();
    if !app.repos.is_empty() {
        state.select(Some(app.repo_sel));
    }
    frame.render_stateful_widget(list, area, &mut state);
}

fn render_activity(frame: &mut Frame, app: &App, area: Rect) {
    match app.activity {
        Activity::Log => render_log(frame, app, area),
        Activity::Releases => render_releases(frame, app, area),
    }
}

fn render_log(frame: &mut Frame, app: &App, area: Rect) {
    let items: Vec<ListItem> = app
        .pull
        .ops
        .iter()
        .map(|op| {
            let vetoed = app.pull.veto.get(&op.id).is_some_and(|v| !v.is_empty());
            let id = op.id.chars().take(10).collect::<String>();
            let mut spans = vec![
                Span::styled(id, Style::new().fg(Color::Yellow)),
                Span::raw("  "),
                Span::styled(op.at.clone(), Style::new().fg(Color::DarkGray)),
                Span::raw("  "),
                Span::raw(op.path.clone()),
            ];
            if vetoed {
                spans.push(Span::styled(
                    "  ⛔",
                    Style::new().fg(Color::Red).add_modifier(Modifier::BOLD),
                ));
            }
            ListItem::new(Line::from(spans))
        })
        .collect();
    let title = format!("Log · {}", app.view);
    let list = List::new(items)
        .block(pane_block(&title, app.focus == Focus::Log))
        .highlight_style(selected_style())
        .highlight_symbol("▌ ");
    let mut state = ListState::default();
    if !app.pull.ops.is_empty() {
        state.select(Some(app.op_sel));
    }
    frame.render_stateful_widget(list, area, &mut state);
}

fn render_releases(frame: &mut Frame, app: &App, area: Rect) {
    let items: Vec<ListItem> = app
        .releases
        .iter()
        .map(|release| {
            ListItem::new(Line::from(vec![
                Span::styled(
                    release.tag.clone(),
                    Style::new().fg(Color::Yellow).add_modifier(Modifier::BOLD),
                ),
                Span::raw("  "),
                Span::styled(release.at.clone(), Style::new().fg(Color::DarkGray)),
                Span::raw("  "),
                Span::raw(release.view.clone()),
            ]))
        })
        .collect();
    let list = List::new(items)
        .block(pane_block("Releases", app.focus == Focus::Log))
        .highlight_style(selected_style())
        .highlight_symbol("▌ ");
    let mut state = ListState::default();
    if !app.releases.is_empty() {
        state.select(Some(app.release_sel));
    }
    frame.render_stateful_widget(list, area, &mut state);
}

fn render_detail(frame: &mut Frame, app: &App, area: Rect) {
    match app.activity {
        Activity::Log => render_op_detail(frame, app, area),
        Activity::Releases => render_release_detail(frame, app, area),
    }
}

fn render_op_detail(frame: &mut Frame, app: &App, area: Rect) {
    let mut lines: Vec<Line> = Vec::new();
    if let Some(op) = app.selected_op() {
        let id = op.id.chars().take(10).collect::<String>();
        lines.push(Line::from(vec![
            Span::styled(id, Style::new().fg(Color::Yellow)),
            Span::raw(format!("  {}", op.path)),
        ]));
        lines.push(Line::from(Span::styled(
            format!("{}  by {}", op.at, op.author),
            Style::new().fg(Color::DarkGray),
        )));
        lines.push(Line::raw(""));

        lines.push(Line::from("Why".bold()));
        match app.pull.prov.get(&op.id) {
            Some(records) if !records.is_empty() => {
                for p in records {
                    lines.push(Line::from(format!("  [{}] {}", p.actor_kind, p.intent)));
                    if !p.reasoning.is_empty() && p.reasoning != p.intent {
                        lines.push(Line::from(Span::styled(
                            format!("    {}", p.reasoning),
                            Style::new().fg(Color::DarkGray),
                        )));
                    }
                }
            }
            _ => lines.push(Line::from(Span::styled(
                "  (no why recorded)",
                Style::new().fg(Color::DarkGray),
            ))),
        }

        // Signatures are not verified client-side yet, so vetoes are shown as
        // claimed rather than labelled verified/unverified.
        if let Some(vetoes) = app.pull.veto.get(&op.id) {
            if !vetoes.is_empty() {
                lines.push(Line::raw(""));
                lines.push(Line::from("Vetoes (unverified)".red().bold()));
                for v in vetoes {
                    lines.push(Line::from(format!("  {}: {}", v.reviewer, v.reason)));
                    if !v.at.is_empty() {
                        lines.push(Line::from(Span::styled(
                            format!("    {}", v.at),
                            Style::new().fg(Color::DarkGray),
                        )));
                    }
                }
            }
        }
    } else {
        lines.push(Line::from(Span::styled(
            "select an op",
            Style::new().fg(Color::DarkGray),
        )));
    }
    let para = Paragraph::new(lines)
        .block(pane_block("Detail", false))
        .wrap(Wrap { trim: false });
    frame.render_widget(para, area);
}

fn render_release_detail(frame: &mut Frame, app: &App, area: Rect) {
    let mut lines: Vec<Line> = Vec::new();
    if let Some(release) = app.selected_release() {
        lines.push(Line::from(release.tag.clone().yellow().bold()));
        lines.push(Line::from(Span::styled(
            release.at.clone(),
            Style::new().fg(Color::DarkGray),
        )));
        lines.push(Line::raw(""));
        lines.push(Line::from(format!("signer: {}", release.signed_by)));
        lines.push(Line::from(format!("id: {}", release.id)));
        lines.push(Line::from(format!("view: {}", release.view)));
        lines.push(Line::from(format!("heads: {}", release.heads.len())));
        lines.push(Line::from(format!("commits: {}", release.commits.len())));
        lines.push(Line::raw(""));
        lines.push(Line::from("Notes".bold()));
        lines.push(Line::from(
            release
                .notes
                .as_deref()
                .unwrap_or("(no release notes)")
                .to_string(),
        ));
        lines.push(Line::raw(""));
        lines.push(Line::from("Artifacts".bold()));
        if release.artifacts.is_empty() {
            lines.push(Line::from(Span::styled(
                "  (none)",
                Style::new().fg(Color::DarkGray),
            )));
        } else {
            for artifact in &release.artifacts {
                let size = artifact
                    .size
                    .map(|n| format!("{n} bytes"))
                    .unwrap_or_else(|| "size unknown".to_string());
                let media = artifact.media_type.as_deref().unwrap_or("media unknown");
                lines.push(Line::from(format!("  {} ({size}, {media})", artifact.name)));
                lines.push(Line::from(Span::styled(
                    format!("    {}", artifact.uri),
                    Style::new().fg(Color::DarkGray),
                )));
                lines.push(Line::from(Span::styled(
                    format!("    sha256 {}", artifact.sha256),
                    Style::new().fg(Color::DarkGray),
                )));
            }
        }
    } else {
        lines.push(Line::from(Span::styled(
            "select a release",
            Style::new().fg(Color::DarkGray),
        )));
    }
    let para = Paragraph::new(lines)
        .block(pane_block("Release detail", false))
        .wrap(Wrap { trim: false });
    frame.render_widget(para, area);
}

fn render_status(frame: &mut Frame, app: &App, area: Rect) {
    let hints =
        "q quit · Tab focus · j/k move · Enter open · t log/releases · r refresh · R reputation";
    let left = if app.status.is_empty() {
        app.server_label.clone()
    } else {
        app.status.clone()
    };
    let line = Line::from(vec![
        Span::styled(
            format!(" {left} "),
            Style::new().fg(Color::White).bg(ACCENT),
        ),
        Span::raw("  "),
        Span::styled(hints, Style::new().fg(Color::DarkGray)),
    ]);
    frame.render_widget(Paragraph::new(line), area);
}

/// A centered popup rectangle `pct_x`×`pct_y` of `area`.
fn centered(area: Rect, pct_x: u16, pct_y: u16) -> Rect {
    let [row] = Layout::vertical([Constraint::Percentage(pct_y)])
        .flex(Flex::Center)
        .areas(area);
    let [cell] = Layout::horizontal([Constraint::Percentage(pct_x)])
        .flex(Flex::Center)
        .areas(row);
    cell
}

fn render_reputation(frame: &mut Frame, rep: &Reputation, area: Rect) {
    let popup = centered(area, 60, 40);
    frame.render_widget(Clear, popup);
    let mut lines = vec![
        Line::from(rep.subject.clone().bold()),
        Line::raw(""),
        Line::from(format!(
            "attested: {}    claimed: {}",
            rep.attested, rep.claimed
        )),
    ];
    let mut kinds: Vec<(&String, &i64)> = rep.by_kind.iter().filter(|(_, n)| **n > 0).collect();
    kinds.sort_by(|a, b| a.0.cmp(b.0));
    let by_kind = if kinds.is_empty() {
        "(none)".to_string()
    } else {
        kinds
            .iter()
            .map(|(k, n)| format!("{k}={n}"))
            .collect::<Vec<_>>()
            .join(", ")
    };
    lines.push(Line::from(format!("by kind: {by_kind}")));
    lines.push(Line::raw(""));
    lines.push(Line::from(Span::styled(
        "press any key to close",
        Style::new().fg(Color::DarkGray),
    )));
    let para = Paragraph::new(lines)
        .block(pane_block("Reputation", true))
        .wrap(Wrap { trim: false });
    frame.render_widget(para, popup);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app::App;
    use crate::client::{Op, Pull, Release, ReleaseArtifact, Remote};
    use ratatui::backend::TestBackend;
    use ratatui::Terminal;
    use std::collections::HashMap;

    fn app_with_ops() -> App {
        App {
            remote: Remote::new("http://unused"),
            server_label: "http://localhost:4000".into(),
            repos: vec!["acme/web".into()],
            repo_sel: 0,
            view: "main".into(),
            pull: Pull {
                heads: vec![],
                ops: vec![Op {
                    id: "abcdef0123456789".into(),
                    path: "src/auth.rs".into(),
                    at: "2026-07-01T00:00:00Z".into(),
                    author: "did:key:zAlice".into(),
                    lamport: 1,
                }],
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

    fn rendered_text(app: &App) -> String {
        let backend = TestBackend::new(100, 24);
        let mut terminal = Terminal::new(backend).unwrap();
        terminal.draw(|f| render(f, app)).unwrap();
        terminal
            .backend()
            .buffer()
            .content
            .iter()
            .map(|c| c.symbol())
            .collect()
    }

    #[test]
    fn renders_the_panes_and_the_selected_op() {
        let text = rendered_text(&app_with_ops());
        assert!(text.contains("Repos"));
        assert!(text.contains("acme/web"));
        assert!(text.contains("Log"));
        assert!(text.contains("abcdef0123")); // 10-char op id prefix
        assert!(text.contains("src/auth.rs"));
    }

    #[test]
    fn does_not_panic_with_no_repos() {
        let mut app = app_with_ops();
        app.repos.clear();
        app.pull = Pull::default();
        let _ = rendered_text(&app); // must not panic
    }

    #[test]
    fn renders_release_list_and_detail_mode() {
        let mut app = app_with_ops();
        app.activity = Activity::Releases;
        app.releases = vec![Release {
            tag: "v0.1.5-alpha".into(),
            view: "main".into(),
            at: "2026-07-09T12:00:00.000Z".into(),
            heads: vec!["h1".into()],
            commits: vec!["c1".into(), "c2".into()],
            notes: Some("Signed metadata release".into()),
            artifacts: vec![ReleaseArtifact {
                name: "thaddeus.tar.gz".into(),
                uri: "https://cdn.example/thaddeus.tar.gz".into(),
                sha256: "0123456789abcdef".repeat(4),
                size: Some(42),
                media_type: Some("application/gzip".into()),
            }],
            id: "release0123456789".into(),
            signed_by: "did:key:zAlice".into(),
        }];

        let text = rendered_text(&app);
        assert!(text.contains("Releases"));
        assert!(text.contains("v0.1.5-alpha"));
        assert!(text.contains("did:key:zAlice"));
        assert!(text.contains("view: main"));
        assert!(text.contains("heads: 1"));
        assert!(text.contains("commits: 2"));
        assert!(text.contains("Signed metadata release"));
        assert!(text.contains("thaddeus.tar.gz"));
    }
}
