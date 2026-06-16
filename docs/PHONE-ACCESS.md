# Reviewing from your phone

otacon reviews work just as well from a phone as from your desk. Access runs over
[Tailscale](https://tailscale.com), so your plans never leave your own devices —
there is no public endpoint and no separate login to manage. The tailnet *is* the
auth: if a device is on your tailnet, it can reach the review surface; if it isn't,
it can't.

## Setup

1. **Install Tailscale on the Mac and the phone, and log in.**
   Install the Tailscale app on both devices and run `tailscale up` (or log in
   through the app) so they share one tailnet.

2. **Enable HTTPS Certificates for the tailnet.**
   In the Tailscale admin console, go to **DNS → Enable HTTPS** (MagicDNS must be
   on). This is the one step otacon cannot do for you — it's an account-level
   setting only you can flip.

3. **Run `otacon expose`.**
   ```sh
   otacon expose
   ```
   This configures `tailscale serve` for the daemon's port, verifies that the
   tailnet URL actually serves, and prints the HTTPS URL with `verified: true`.
   Bookmark that URL on your phone — that's your review surface.

4. **Keep the Mac awake while a plan is in review.**
   ```sh
   caffeinate -i
   ```
   A sleeping Mac drops the daemon and the Tailscale serve, so the phone can't
   reach it. `caffeinate -i` keeps it awake; stop it (Ctrl-C) when you're done.

## If the URL won't verify

If you skip step 2 (enabling HTTPS Certificates), `tailscale serve` still
*succeeds* — but the URL resets on every TLS handshake, so it's effectively dead.
otacon detects this: `otacon expose` reports `verified: false` and links you to the
admin DNS page instead of handing you a URL that won't work.

> **Just enabled HTTPS?** The certificate can take a minute to provision. Wait a
> moment and re-run `otacon expose`.

## Mac App Store Tailscale: PATH note

If you installed Tailscale from the Mac App Store, putting `tailscale` on your
`PATH` needs a **manual launcher** — a small wrapper script that runs the
app-bundle binary. A bare symlink to the app-bundle binary crashes, so don't create
one.

You don't strictly need `tailscale` on your `PATH` for otacon, though: otacon finds
the app-bundle binary on its own either way. The PATH launcher only matters if you
want to call `tailscale` yourself from the terminal.
