/**
 * Host half of dsh-longsession.
 *
 * The whole feature is browser-side: the client bundle tunes Session history
 * page requests and optionally applies measured rendering containment to the
 * transcript. This half exists because a client bundle is served only for an
 * enabled Loader row, and a Loader row needs a mountable host plugin.
 *
 * It contributes no services, no routes, and nothing model-visible. The
 * `config` object declared on this row reaches the browser half as `apply(ctx,
 * config)`; see lib/client.js for the accepted fields.
 */

/** @type {{ name: string, apply: () => void }} */
const plugin = {
  name: 'dsh-longsession',
  apply() {},
}

export default plugin
export const inject = []