/**
 * Post-promote bump of `FH_LEARNED_VERSION` on the Railway game service
 * (fh-azx.8). Railway treats a variable change as a redeploy, which is
 * how a freshly uploaded overlay becomes visible to import-time boot
 * load. The game process does not need to read the value.
 *
 * Required env:
 *   `RAILWAY_TOKEN` — project token. Unset → warn and skip (promote
 *   still counts as success; artifacts are already in the bucket).
 *
 * Optional env (defaults are the production five-hundred IDs):
 *   `FH_GAME_SERVICE_ID`
 *   `FH_RAILWAY_PROJECT_ID` (else `RAILWAY_PROJECT_ID`)
 *   `FH_RAILWAY_ENVIRONMENT_ID` (else `RAILWAY_ENVIRONMENT_ID`)
 */

export const LEARNED_VERSION_VAR = 'FH_LEARNED_VERSION';
export const RAILWAY_GRAPHQL_URL = 'https://backboard.railway.com/graphql/v2';

/** Production `five-hundred` game service. Overridable via `FH_GAME_SERVICE_ID`. */
export const DEFAULT_GAME_SERVICE_ID = 'f9819cce-f49b-427e-bf5b-5fa9f071bc7c';
/** Production project. Overridable via `FH_RAILWAY_PROJECT_ID`. */
export const DEFAULT_PROJECT_ID = '4c5c501b-5450-444f-81ea-f65588801a53';
/** Production environment. Overridable via `FH_RAILWAY_ENVIRONMENT_ID`. */
export const DEFAULT_ENVIRONMENT_ID = '9f5a788a-052e-404e-8b7b-ef3c562ac297';

export const VARIABLE_UPSERT_MUTATION = `mutation variableUpsert($input: VariableUpsertInput!) {
  variableUpsert(input: $input)
}`;

export type ApplyEnv = Record<string, string | undefined>;

export interface ApplyLearnedVersionOptions {
  /** Injected HTTP; tests mock this so the helper never opens a socket. */
  readonly fetch?: typeof globalThis.fetch;
  readonly warn?: (line: string) => void;
  readonly log?: (line: string) => void;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Set `FH_LEARNED_VERSION=<version>` on the game service. Missing token,
 * empty version, and transport failures are logged and swallowed — the
 * caller treats a completed upload as success either way.
 */
export async function applyLearnedVersion(
  version: string,
  env: ApplyEnv = process.env,
  options: ApplyLearnedVersionOptions = {},
): Promise<void> {
  const warn = options.warn ?? ((line: string) => console.warn(line));
  const log = options.log ?? ((line: string) => console.log(line));
  const doFetch = options.fetch ?? globalThis.fetch;

  if (version.trim() === '') {
    warn('[applyOverlay] empty overlay version; not setting FH_LEARNED_VERSION');
    return;
  }

  const token = env.RAILWAY_TOKEN?.trim() ?? '';
  if (token === '') {
    warn('[applyOverlay] RAILWAY_TOKEN unset; skip FH_LEARNED_VERSION bump');
    return;
  }

  const projectId = env.FH_RAILWAY_PROJECT_ID ?? env.RAILWAY_PROJECT_ID ?? DEFAULT_PROJECT_ID;
  const environmentId =
    env.FH_RAILWAY_ENVIRONMENT_ID ?? env.RAILWAY_ENVIRONMENT_ID ?? DEFAULT_ENVIRONMENT_ID;
  const serviceId = env.FH_GAME_SERVICE_ID ?? DEFAULT_GAME_SERVICE_ID;

  try {
    const res = await doFetch(RAILWAY_GRAPHQL_URL, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        query: VARIABLE_UPSERT_MUTATION,
        variables: {
          input: {
            projectId,
            environmentId,
            serviceId,
            name: LEARNED_VERSION_VAR,
            value: version,
          },
        },
      }),
    });
    const text = await res.text();
    if (!res.ok) {
      warn(`[applyOverlay] Railway variableUpsert HTTP ${String(res.status)}: ${text}`);
      return;
    }
    let body: { errors?: readonly { message?: string }[] };
    try {
      body = JSON.parse(text) as { errors?: readonly { message?: string }[] };
    } catch {
      warn(`[applyOverlay] Railway variableUpsert non-JSON: ${text}`);
      return;
    }
    if (body.errors !== undefined && body.errors.length > 0) {
      const messages = body.errors.map((e) => e.message ?? 'unknown').join('; ');
      warn(`[applyOverlay] Railway variableUpsert error: ${messages}`);
      return;
    }
    log(`[applyOverlay] set ${LEARNED_VERSION_VAR}=${version} on ${serviceId}`);
  } catch (err) {
    warn(`[applyOverlay] Railway variableUpsert failed: ${errText(err)}`);
  }
}
