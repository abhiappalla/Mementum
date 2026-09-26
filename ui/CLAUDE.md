# RAMspread — Desktop UI

## What This Is
RAMspread is an intelligent memory management daemon for macOS (expanding to Windows/Linux). It monitors RAM pressure, classifies processes as Protected/Neutral/Evictable, and suspends idle low-priority processes to free memory for high-priority workloads like local LLMs.

The daemon is already built in Rust at `~/ramspread-daemon/`. It exposes an HTTP API at `http://127.0.0.1:7779`. This Tauri app is the frontend.

## Architecture
- **Daemon** (separate process): Rust binary at `~/ramspread-daemon/`, must be running for the UI to work
- **This app**: Tauri v2 + React + TypeScript, connects to daemon via HTTP on localhost:7779
- **Config**: User preferences stored at `~/.ramspread/config.json`
- **Recovery**: Suspended PIDs stored at `~/.ramspread/suspended.json`

## Daemon API

All requests are POST to `http://127.0.0.1:7779` with JSON body.

### Get Status
```json
{ "action": "get_status" }
```
Returns:
```json
{
  "total_ram_gb": 16.0,
  "used_ram_gb": 11.09,
  "pressure_percent": 69.3,
  "pressure_label": "MODERATE",
  "suspended_count": 0,
  "foreground_app": "terminal",
  "processes": [
    {
      "name": "ollama",
      "pid": 12345,
      "memory_mb": 3433,
      "cpu_percent": 4.2,
      "classification": "PROTECTED",
      "status": "IDLE"
    }
  ],
  "protected_mb": 1586,
  "evictable_mb": 3312,
  "auto_optimize": true
}
```

### Set Override
```json
{ "action": "set_override", "process": "spotify", "class": "protected" }
```

### Optimize Now
```json
{ "action": "optimize_now" }
```

### Toggle Auto
```json
{ "action": "toggle_auto" }
```

Process statuses: `SUSPENDED`, `FOCUSED`, `ACTIVE`, `IDLE`
Classifications: `PROTECTED`, `NEUTRAL`, `EVICTABLE`
Pressure labels: `NORMAL` (<60%), `MODERATE` (60-75%), `CRITICAL` (>75%)

## Design System — Black & Gold

### Core Palette
| Token | Hex | Usage |
|---|---|---|
| Primary Black | #000000 | Background |
| Surface Black | #0A0A0A | App background |
| Elevated Surface | #161616 | Cards, panels |
| Gold Accent | #D4AF37 | Primary actions, highlights |
| Gold Glow | #F6E27A | Hover states, emphasis |
| Silver Accent | #C0C0C0 | Secondary elements, borders |
| Brushed Silver | #8A8A8A | Icons, graph lines |
| Primary Text | #FFFFFF | Main text |
| Secondary Text | #B3B3B3 | Labels, descriptions |

### Typography
- Font: -apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Inter', sans-serif
- Monospace: 'SF Mono', 'JetBrains Mono', monospace
- Large status text: 48px, font-weight 700
- Stat values: 28px, font-weight 700, tabular-nums
- Labels: 11px, uppercase, letter-spacing 0.5px, color Secondary Text
- Body: 14px, font-weight 400

### Visual Rules
- Silver is for depth — thin borders, icons, graph lines, subtle gradients. Never for primary buttons or hero elements.
- Gold is for action and status — buttons, shields, pause icons, active states.
- Corners: 12px for cards, 8px for buttons, 4px for small elements.
- Shadows: Avoid drop shadows. Use 1px borders in Silver at 15% opacity.
- Animations: Smooth, 200-300ms transitions. Suspended processes fade to 50% opacity. Resumed processes fade back gracefully.

### Button Styles
| Type | Style |
|---|---|
| Primary | Gold fill (#D4AF37), black text |
| Secondary | Dark surface (#161616), silver border |
| Hover | Gold glow effect |
| Card hover | Silver edge highlight |

## UI Structure

### Loading Screen (4 seconds total)
0-3 seconds: Near-black screen with very subtle motherboard trace pattern at 5-10% opacity. Gold particles enter from left, travel along invisible circuit paths, leaving glowing gold traces that reveal motherboard circuitry. Movement should feel intelligent and purposeful. RAMspread logo centered but dim. Status line cycles: "Analyzing Memory Topology" → "Building Process Graph" → "Initializing Protection Engine"

3-4 seconds: Particles converge toward center. Full motherboard becomes visible through smooth fade. Components materialize from illuminated paths. Logo reaches full brightness. Status: "Optimization Engine Ready"

Transition: Motherboard traces morph into dashboard UI grid lines, card boundaries. Circuit traces become layout structure. The loading screen IS the app waking up.

Colors: Dark background, gold traces, silver component highlights. NO cyberpunk, NO gamer RGB. Premium OS startup feel.

### Dashboard (Main View)
DO NOT lead with technical metrics, process tables, or memory graphs.

**Primary element**: Large central "System Status" card communicating what RAMspread is doing in plain language:
- "Everything is optimized" (NORMAL)
- "Protecting your workload" (MODERATE)
- "Optimizing memory..." (CRITICAL, actively suspending)
- "Freeing memory now" (CRITICAL, suspension in progress)

**Memory indicator**: Fluid-style animated reservoir or modern visual indicator, NOT traditional gauges/dials. Background color shifts subtly: green-tinted when healthy, amber when rising, red when intervening.

**Stats**: Available Again (GB reclaimed), Suspended (count), Protected (count), Pressure (%)

**Recent Actions**: Narrative cards, NOT log entries. Examples:
- "Chrome paused after 18 minutes of inactivity — 2.1 GB made available"
- "Chrome resumed — you switched back, focus detected"
- "4.2 GB made available for active workloads"

### Processes View
NO spreadsheet-style table. Each application displayed as a large clean card showing:
- App name (large)
- Memory usage
- Classification (segmented control: Protected | Neutral | Evictable — single click to change)
- Idle state / status

**Protected apps**: Gold shield icon, reassuring visual
**Suspended apps**: Gold pause icon, reduced opacity (50%)
**Focused/Active apps**: Subtle glow or animation showing RAMspread recognizes it

### History View
Narrative chronological story of how RAMspread protected the system throughout the day. Cards describing:
- Pressure events
- Memory reclaimed
- Application resumes
- Workload protection decisions

Human-readable: "Chrome paused after 18 minutes of inactivity" NOT "SIGSTOP sent to PID 7302"

### Menu Bar
- Simple memory icon with subtle status color indicator
- Shows: monitoring / optimizing / responding to pressure
- Click opens the full dashboard

## UX Principles
1. **Calm, confident, intelligent** — most of the time users are NOT interacting directly
2. **Notifications focus on value**: "4.2 GB made available" NOT "Chrome suspended"
3. **Smooth transitions**: Suspended apps fade gently, resume gracefully
4. **The app should feel like an intelligent assistant**, not a system monitor
5. **Premium feel**: BlackRock terminal meets high-end automotive UI meets motherboard circuitry

## Tech Stack
- Tauri v2
- React + TypeScript
- Vite
- No external CSS frameworks — custom CSS with the design system above
- Fetch API to communicate with daemon at localhost:7779
- Poll daemon every 3 seconds for live data

## File Structure
```
src/
├── App.tsx              — Main app with routing
├── App.css              — Global styles and design tokens
├── components/
│   ├── LoadingScreen.tsx — 4-second boot animation
│   ├── Dashboard.tsx     — Main status view
│   ├── ProcessList.tsx   — Application cards with controls
│   ├── History.tsx       — Narrative action log
│   ├── StatusCard.tsx    — Central status indicator
│   ├── MemoryIndicator.tsx — Fluid pressure visualization
│   └── ProcessCard.tsx   — Individual app card with segmented control
├── hooks/
│   └── useDaemon.ts     — Fetch + polling hook for daemon API
├── types/
│   └── index.ts         — TypeScript interfaces matching daemon API
└── utils/
    └── api.ts           — Daemon HTTP client
```

## Important Notes
- The daemon must be running separately (`sudo ./target/debug/ramspread-daemon` from `~/ramspread-daemon/`)
- All communication is localhost only — no internet, no telemetry
- Show a clear "Daemon not connected" state if the daemon isn't running
- The app must handle daemon disconnection gracefully
- Never show raw PIDs, signal names, or technical process details to the user
