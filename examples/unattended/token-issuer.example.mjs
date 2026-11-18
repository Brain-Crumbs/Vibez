/**
 * Interface example only. Copy into a private host directory and implement with
 * a trusted issuer or credential broker, then pin this module's SHA-256.
 * Never put credential values, private keys, or issuer state in a consumer.
 *
 * issue("controller") -> {
 *   token, repository, appId, installationId, expiresAt,
 *   permissions: { metadata: "read", contents: "write", pull_requests: "write" }
 * }
 * issue("worker") -> {
 *   token, repository, appId, installationId, expiresAt,
 *   permissions: { metadata: "read", contents: "read", pull_requests: "read" }
 * }
 * issue("publisher") -> {
 *   token, repository, principal, expiresAt,
 *   permissions: { contents: "write", pull_requests: "write" }
 * }
 *
 * The controller's numeric App ID must match the reviewed branch restriction.
 * Worker token permissions must come from the actual narrowed installation
 * response. All three credentials must be distinct. The publisher may use an
 * explicitly authorized owner CLI credential, captured internally by the issuer.
 * expiresAt is the actual issuer expiry or a shorter broker lease.
 * No credential is mounted or inherited by the local model or validator.
 * Never log or write the returned credential object as audit output.
 */
export async function issue(_role) {
  throw new Error("Configure the trusted host credential issuer before enabling unattended execution.");
}
