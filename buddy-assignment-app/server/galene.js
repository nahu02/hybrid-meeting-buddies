/**
 * Client for the assignment endpoints of Galene's HTTP API
 * (webserver/api.go: assignmentAPIHandler).
 */

/**
 * @typedef {{id: string, username?: string, role?: string, assignedTo?: string}} GaleneClient
 */

/**
 * @param {string} baseUrl Galene's URL, e.g. http://localhost:8443
 */
export function galeneClient(baseUrl) {
  const base = baseUrl.replace(/\/+$/, "");

  // Group names may contain slashes (subgroups): escape each segment
  // but keep the slashes.
  const url = (group, kind) =>
    `${base}/galene-api/v0/.groups/` +
    group.split("/").map(encodeURIComponent).join("/") +
    `/.${kind}`;

  async function request(method, target, body) {
    const r = await fetch(target, {
      method,
      headers: body === undefined
        ? {}
        : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!r.ok) {
      const text = (await r.text()).trim();
      throw new Error(
        `Galene ${method} ${target}: ${r.status} ${text || r.statusText}`
      );
    }
    return r.status === 204 ? null : r.json();
  }

  return {
    /** @returns {Promise<GaleneClient[]>} */
    listClients: (group) => request("GET", url(group, "clients")),

    /** Replace all buddy pairs of the group ([] clears them). */
    setAssignment: (group, pairs) =>
      request("PUT", url(group, "assignment"), pairs),

    /** Offer links to clients: [{client, url}]. */
    openUrls: (group, targets) =>
      request("POST", url(group, "open-url"), targets),
  };
}
