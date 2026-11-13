// Creates a Gitea pull mirror for every GitHub repository the token's account owns, once an hour.
//
// Gitea keeps each mirror in sync on its own schedule; this script only adds the repositories
// Gitea has no copy of yet. It never deletes or changes a repository on either side, so a
// repository deleted or renamed on GitHub keeps its old copy in Gitea.
//
// No imports: the container runs this file as it is, with no dependency to download.

/** What one pass needs: both tokens and the Gitea address the container reaches. */
export interface MirrorConfig {
  githubToken: string
  giteaUrl: string
  giteaToken: string
}

/** The fields of a GitHub repository this script reads. */
interface GithubRepo {
  name: string
  clone_url: string
  private: boolean
  description: string | null
  owner: { login: string }
}

/** What one pass did, by repository name. */
export interface MirrorResult {
  created: string[]
  failed: string[]
}

const PAGE_SIZE = 100
const HOUR_MS = 60 * 60 * 1000

/** Every repository the token's account owns, forks and archived ones included. */
async function githubRepos(token: string, fetchFn: typeof fetch): Promise<GithubRepo[]> {
  const repos: GithubRepo[] = []
  for (let page = 1;; page++) {
    const url = `https://api.github.com/user/repos?affiliation=owner&per_page=${PAGE_SIZE}` +
      `&page=${page}`
    const res = await fetchFn(url, {
      headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json" },
    })
    if (!res.ok) throw new Error(`GitHub ${res.status} listing repositories`)
    const batch = await res.json() as GithubRepo[]
    repos.push(...batch)
    if (batch.length < PAGE_SIZE) return repos
  }
}

/**
 * Creates a Gitea mirror for each owned GitHub repository that has no Gitea repository of the
 * same name under the Gitea token's user. One failed repository does not stop the others; a
 * failed GitHub or Gitea user lookup throws, since nothing can be compared without it.
 */
export async function mirrorNew(
  config: MirrorConfig,
  fetchFn: typeof fetch = fetch,
): Promise<MirrorResult> {
  const gitea = (path: string, init: RequestInit = {}) =>
    fetchFn(`${config.giteaUrl}/api/v1${path}`, {
      ...init,
      headers: { authorization: `token ${config.giteaToken}`, "content-type": "application/json" },
    })

  const userRes = await gitea("/user")
  if (!userRes.ok) throw new Error(`Gitea ${userRes.status} reading the token's user`)
  const owner = (await userRes.json() as { login: string }).login

  const result: MirrorResult = { created: [], failed: [] }
  for (const repo of await githubRepos(config.githubToken, fetchFn)) {
    const existing = await gitea(`/repos/${owner}/${encodeURIComponent(repo.name)}`)
    await existing.body?.cancel()
    if (existing.ok) continue
    if (existing.status !== 404) {
      result.failed.push(`${repo.name} (lookup ${existing.status})`)
      continue
    }
    const created = await gitea("/repos/migrate", {
      method: "POST",
      body: JSON.stringify({
        clone_addr: repo.clone_url,
        repo_name: repo.name,
        repo_owner: owner,
        mirror: true,
        private: repo.private,
        description: repo.description ?? "",
        service: "git",
        auth_username: repo.owner.login,
        auth_password: config.githubToken,
      }),
    })
    await created.body?.cancel()
    // The status only: an error body may quote the clone request.
    if (created.ok) result.created.push(repo.name)
    else result.failed.push(`${repo.name} (migrate ${created.status})`)
  }
  return result
}

/** The value of a required environment variable; throws when it is unset or empty. */
function requiredEnv(key: string): string {
  const value = Deno.env.get(key)
  if (!value) throw new Error(`${key} is not set`)
  return value
}

if (import.meta.main) {
  const config: MirrorConfig = {
    githubToken: requiredEnv("GITHUB_TOKEN"),
    giteaUrl: requiredEnv("GITEA_URL"),
    giteaToken: requiredEnv("GITEA_TOKEN"),
  }
  while (true) {
    try {
      const { created, failed } = await mirrorNew(config)
      console.log(`created ${created.length} mirrors: ${created.join(", ") || "none"}`)
      if (failed.length) console.error(`failed ${failed.length}: ${failed.join(", ")}`)
    } catch (error) {
      const cause = error instanceof Error && error.cause ? ` (${error.cause})` : ""
      console.error(`pass failed: ${error instanceof Error ? error.message : error}${cause}`)
    }
    await new Promise((resolve) => setTimeout(resolve, HOUR_MS))
  }
}
