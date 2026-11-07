/**
 * Registering this machine as an organisation's node (docs/96 §4) — the interface the first run
 * calls (INV-1696), filled in by INV-1697.
 *
 * INV-1697 builds the registration itself: the person signs in to the organisation as an Admin
 * (Feishu or DingTalk, through the organisation's own sign-in page, as joining does in
 * organisation-windows.cjs — no code typed), the organisation issues a node credential, and the
 * machine registers its boxes with the organisation. Until then `available` is false and
 * `register` refuses, so choosing "organisation node" on the first run stops at a step that says
 * so and records nothing: no use is written and nothing is created, and the person may go back
 * and choose again.
 *
 * The shape INV-1697 keeps: `available` says whether this build can register a node, and
 * `register({ address })` resolves with `{ organisation: { name, origin } }` once the machine is
 * the organisation's node, after which the shell records the use `organisation-node`.
 */
class NodeRegistrationUnavailable extends Error {
  constructor() {
    super("organisation node registration arrives with INV-1697");
    this.code = "node-not-yet";
  }
}

function organisationNode() {
  return {
    available: false,
    async register() { throw new NodeRegistrationUnavailable(); },
  };
}

module.exports = { NodeRegistrationUnavailable, organisationNode };
