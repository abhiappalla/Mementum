# MEMentum Daemon

> Intelligent memory management for AI workloads. Free. Forever.

[![License: Proprietary Freeware](https://img.shields.io/badge/License-Proprietary%20Freeware-gold.svg)]()
[![Platform: macOS](https://img.shields.io/badge/Platform-macOS-silver.svg)]()
[![Platform: Windows](https://img.shields.io/badge/Platform-Windows-silver.svg)]()
[![Platform: Linux](https://img.shields.io/badge/Platform-Linux-silver.svg)]()
[![Built with: Rust](https://img.shields.io/badge/Built%20with-Rust-orange.svg)]()

MEMentum is an intelligent background daemon that monitors your system memory in real time, classifies every running process by importance, and automatically suspends idle low-priority processes to free RAM for your AI workloads — without closing a single app.

## What it does

- **Protects your AI models** — Ollama and LM Studio get full priority. Chrome tabs wait.
- **Freezes idle apps, not active ones** — Focus detection ensures you never lose control of what you're using.
- **Resumes everything instantly** — Switch to any frozen app and it comes back in milliseconds.

## How MEMentum Runs

MEMentum only runs while the app is open. There is no persistent background service and nothing starts at boot.

**Closing the window (red X)** — MEMentum keeps running and stays visible in your macOS menu bar. Your apps stay optimized while you work. Click the menu bar icon to reopen the window.

**Quitting (Cmd+Q or Quit from the menu bar)** — MEMentum shuts down completely. Every paused app resumes immediately, all process priorities are restored, and the engine exits. Nothing is left running.

**If MEMentum crashes or is force quit** — the engine detects this within 15 seconds and automatically resumes every paused app before exiting.

You can verify at any time that nothing is running:
```bash
ps aux | grep mementum-daemon
```

MEMentum never installs a LaunchAgent, never starts at login, and never runs when you have quit it.

## Key Features

- AI-first classification (Ollama/LM Studio port detection + model scanning)
- Focus-aware suspension (never freeze what you're actively using)
- Process dependency tree (never break tool chains)
- Electron app keepalive (Slack, Discord stay connected while frozen)
- Context window tracking and KV cache growth monitoring
- Smart eviction ordering (eviction score based on memory, idle time, resume frequency)
- Adaptive thresholds (learns your machine over 100 data points)
- Natural compression measurement (tracks macOS compression savings)
- Memory budgets per app
- Focus sessions
- Daily digest
- Cross-platform: macOS (SIGSTOP/SIGCONT), Windows (NtSuspendProcess), Linux (cgroups v2)
- Fully local — no telemetry, no internet, no cloud

## Installation

### Quick Install (macOS)
```bash
git clone https://github.com/abhiramappalla/mementum-daemon
cd mementum-daemon
cargo build --release
./install.sh
```

### Verify it's running
```bash
launchctl list | grep mementum
```

## API Reference

MEMentum exposes an HTTP API on localhost:7779. All requests require the `X-MEMentum-Token` header (read from `~/.mementum/api_token` on first run).

```bash
TOKEN=$(cat ~/.mementum/api_token)

# Get full system status
curl -X POST http://127.0.0.1:7779 -H "X-MEMentum-Token: $TOKEN" -d '{"action":"get_status"}'

# Optimize now (suspend all eligible processes)
curl -X POST http://127.0.0.1:7779 -H "X-MEMentum-Token: $TOKEN" -d '{"action":"optimize_now"}'

# Start focus session for a specific app
curl -X POST http://127.0.0.1:7779 -H "X-MEMentum-Token: $TOKEN" -d '{"action":"start_focus","process":"ollama"}'

# End focus session
curl -X POST http://127.0.0.1:7779 -H "X-MEMentum-Token: $TOKEN" -d '{"action":"end_focus"}'

# Get detected AI models and RAM requirements
curl -X POST http://127.0.0.1:7779 -H "X-MEMentum-Token: $TOKEN" -d '{"action":"get_models"}'

# Set memory budget for an app (MB)
curl -X POST http://127.0.0.1:7779 -H "X-MEMentum-Token: $TOKEN" -d '{"action":"set_budget","process":"google chrome","limit_mb":500}'

# Get today's digest
curl -X POST http://127.0.0.1:7779 -H "X-MEMentum-Token: $TOKEN" -d '{"action":"get_digest"}'

# Get current config
curl -X POST http://127.0.0.1:7779 -H "X-MEMentum-Token: $TOKEN" -d '{"action":"get_config"}'
```

## Configuration

Config lives at `~/.mementum/config.json`

```json
{
  "overrides": {},
  "pressure_threshold": 75.0,
  "resume_threshold": 70.0,
  "auto_optimize": true,
  "budgets": {},
  "idle_timeout_secs": 30,
  "max_suspension_secs": 300
}
```

## Uninstall

```bash
./uninstall.sh
```

## License

Copyright (c) 2026 Abhiram Appalla. All rights reserved.

MEMentum is free to use for any purpose. The source code is available for transparency and audit. Modification, redistribution, and use in competing products is not permitted. See [LICENSE](LICENSE) for full terms.
