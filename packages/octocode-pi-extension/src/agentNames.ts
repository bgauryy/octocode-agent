const AGENT_NAMES = [
  // Octopuses
  'octoTuring',
  'jeffBezopus',
  'elonTentacle',
  'octoNewton',
  'markSuckerberg',
  'inkstein',
  'octoDarwin',
  'linusTorvaldsOpus',
  'octoMusk',
  'stephenInking',
  // Squids
  'squidViciousGates',
  'calamariCurie',
  'squidJobs',
  'nilsBoringSquid',
  'inklaTesla',
  'squidmundFreud',
  'adaLovelacsquid',
  'squidFeynman',
  'calaMariKondo',
  'richardStallsquid',
  // Jellyfish
  'jellyTorvalds',
  'medusaZuckerberg',
  'jellyfishTuring',
  'stingyHawking',
  'jellyWozniak',
  'carlSajelligan',
  'blobGates',
  'jellyfishBezos',
  'jellyDarwin',
  'stingingLovelace',
  // Seahorses
  'sealonMusk',
  'seahorseHopper',
  'poseidonKnuth',
  'seabiscuitBernersLee',
  'neptuneNewton',
  'seahorseDijkstra',
  'sirSeymoreCrayfish',
  'seahorseNoether',
  'poseidonPage',
  'seaBrin',
  // Crabs
  'crabOppenheimer',
  'crustyTorvalds',
  'crabbyTuring',
  'scuttlesVonNeumann',
  'clawDarwin',
  'cancerner',
  'hermitHopper',
  'crabBohr',
  'pinchyPauli',
  'scuttlesworthJobs',
  // Lobsters
  'lobsterLeibniz',
  'clawdiusPtolemy',
  'sirClawNewton',
  'lobsterDijkstra',
  'shelldonCooper',
  'crustyCurie',
  'redShellberg',
  'clawedShannon',
  'lobsterLovelace',
  'thermidorTuring',
  // Sea Turtles
  'tortleTesla',
  'shellKnuth',
  'darwinSlowpoke',
  'shelldonHawking',
  'turtlesworthBabbage',
  'slowpokeSagan',
  'snappyCopernicus',
  'turtBernersLee',
  'slooowVonNeumann',
  'shellNoether',
  // Eels
  'electricEelstein',
  'slipperyStallman',
  'eelMusk',
  'zappyTesla',
  'morayTuring',
  'slickDijkstra',
  'eelCerf',
  'wrigglyWozniak',
  'eelyHopper',
  'joltJobs',
  // Stingrays
  'stingraySagan',
  'zappyZuckerberg',
  'rayKurzweilfish',
  'flatDarwin',
  'stingyStallman',
  'raymondFeynman',
  'mantaGates',
  'stingTorvalds',
  'voltNewton',
  'flatOppenheimer',
  // Misc weirdos
  'blobfishBabbage',
  'mantisShrimpShannon',
  'seaCucumberCurie',
  'anglerfishTuring',
  'nautilusVonNeumann',
  'cuttlefishCook',
  'starfishStallman',
  'seaUrchinTuring',
  'pufferPauli',
  'narwhalKnuth',
] as const;

/**
 * Runners a worker can be spawned under. 'octo' is the Octocode harness itself
 * and the default when no host is recognized (detection is best-effort, never
 * rigid — an unknown terminal/IDE simply tags as 'octo').
 */
export type AgentHost =
  | 'claude'
  | 'cursor'
  | 'codex'
  | 'opencode'
  | 'vscode'
  | 'zed'
  | 'jetbrains'
  | 'octo';

/**
 * Name tag per host: recognizable runner first, sea pun where it writes
 * itself (clawde = Claude with claws, cursea = Cursor at sea).
 */
export const HOST_NAME_TAG: Record<AgentHost, string> = {
  claude: 'clawde',
  cursor: 'cursea',
  codex: 'codex',
  opencode: 'opencode',
  vscode: 'vscode',
  zed: 'zed',
  jetbrains: 'jetbrains',
  octo: 'octo',
};

/**
 * Detect the running host from the environment. `OCTOCODE_AGENT_HOST` wins
 * (the Octocode harness sets it to 'octo' at load, so workers spawned from an
 * Octocode session tag as octo even when the session itself was launched from
 * a Claude Code or Cursor terminal — the env vars those hosts export are
 * inherited and would otherwise misattribute the runner).
 *
 * Recognition is best-effort and only tags a host when a reliable env signal is
 * present; anything unrecognized falls back to 'octo' (never a wrong guess).
 * Note: VS Code forks (Windsurf, etc.) only export `TERM_PROGRAM=vscode`, so
 * they intentionally tag as `vscode` — we don't fabricate a distinct tag.
 */
export function detectAgentHost(env: NodeJS.ProcessEnv = process.env): AgentHost {
  const override = String(env['OCTOCODE_AGENT_HOST'] ?? '').toLowerCase();
  if (override === 'octocode' || override === 'octocode-agent') return 'octo';
  if (Object.prototype.hasOwnProperty.call(HOST_NAME_TAG, override)) return override as AgentHost;

  // Agent CLIs (checked before terminal/IDE signals, which forks also set).
  if (env['CLAUDECODE'] || env['CLAUDE_CODE_ENTRYPOINT']) return 'claude';
  if (env['CURSOR_TRACE_ID'] || env['CURSOR_AGENT']) return 'cursor';
  if (env['CODEX_THREAD_ID'] || env['CODEX_SANDBOX']) return 'codex';
  if (env['OPENCODE'] || env['OPENCODE_CONFIG'] || env['OPENCODE_BIN_PATH']) return 'opencode';
  // IDEs with a distinguishable terminal signal.
  if (env['ZED_TERM']) return 'zed';
  if (String(env['TERMINAL_EMULATOR'] ?? '').includes('JetBrains')) return 'jetbrains';
  if (env['TERM_PROGRAM'] === 'vscode') return 'vscode';
  return 'octo';
}

/**
 * A random funny agent codename tagged with the running host, e.g.
 * `octo-squidJobs`, `clawde-jellyTorvalds`, `cursea-crabBohr` — the tag tells
 * you at a glance which runner (octocode-agent, Claude Code, Cursor, …) the
 * agent lives under when several share one Awareness registry.
 */
export function getRandomAgentName(host: AgentHost = detectAgentHost()): string {
  return `${HOST_NAME_TAG[host]}-${AGENT_NAMES[Math.floor(Math.random() * AGENT_NAMES.length)]}`;
}
