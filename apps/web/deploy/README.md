# Web deployment

The workflow builds Next.js in standalone mode and uploads an immutable release to EC2 with SSH/rsync. PM2 runs `.next/standalone/server.js` as `quotient-web` on localhost port 3100. It includes the built static files and public assets in the standalone directory. Nginx serves the HTTPS product origin and forwards `/api/v1` directly to the separate API process on port 4100.

Configure production environment secrets `EC2_HOST`, `EC2_USER`, `EC2_SSH_KEY`, and pinned `EC2_KNOWN_HOSTS`. Set `EC2_DEPLOY_ROOT=/srv/quotient-web` and `ENABLE_DEPLOY=true` only after provisioning the server. Node 24 LTS and PM2 must be available to the deployment user. The workflow's API rewrite targets `http://127.0.0.1:4100`; use Nginx when serving the API elsewhere.

See the API repository's `deploy/README.md` for full server, TLS, secrets, migration, rollback and monitoring instructions. Deploy a compatible API release first. The web pipeline checks types and builds before deploying; it restores the previous symlink/PM2 configuration if the new homepage fails its HTTP check. Keep prior releases available for an application rollback.

Public widgets use scoped conversation bearer tokens and must not depend on third-party cookies. Owner pages reject framing. The public iframe uses its own scoped bearer token rather than owner cookies; owner mutations require the configured application Origin. Only customer-facing pages should allow framing. Verify postMessage senders in any embed integration and keep API credentials entirely on the backend.

Start with the API repository’s `deploy/LAUNCH.md` and `deploy/COMMERCE.md` for the complete deployment and provider setup. Verify emailed fragment-token restoration, privacy/terms support contact, automatic publishing, human handoff and both embed forms before starting outreach.
