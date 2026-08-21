# Remote Owner attach over the tailnet

Status: proposed

The detached host serves one line-based JSON protocol (attach / owner / stop) on a singleton
Windows named pipe, whose only authentication is the implicit local user session. The Owner also
needs to see "needs you" Owner Notices and answer with Owner lines from another device — mobile
over a personal VPN such as Tailscale — which a pipe cannot serve. We add one optional second
listener to the same host process: a TCP socket bound exclusively to the machine's tailnet
interface address, speaking the identical protocol after a mandatory first `authenticate` line
carrying a pre-shared token whose hash lives in the state directory. The listener is off by
default, is enabled, rotated, and disabled only by explicit local Owner command, refuses to start
when no tailnet interface exists (fail closed, never 0.0.0.0, never loopback), and rejects `stop`
and every other lifecycle request — remote attach converses and observes; start, stop, upgrade,
and rollback stay local. The remote surface is a plain text client reusing the existing attach
loop: replayed transcript, live entries including `CMD_RIKER_WORKER_NOTICE` lines, one input line
at a time. No web page, no new Session View surface, no push channel.

## Considered options

- **Loopback TCP behind `tailscale serve`**: rejected. A loopback port is reachable by every
  local process and every local user without even the pipe's implicit session identity, and the
  proxy rewrites the peer address to loopback, destroying any network-level identity the host
  could check. It also moves half the security configuration outside the host.
- **Unix socket behind `tailscale serve`**: not available on the Windows primary platform.
- **Tailnet peer identity via the Tailscale LocalAPI (`whois`) instead of a token**: better UX
  (no secret on the device) but couples the host to one vendor and to a running LocalAPI; the
  token works over any VPN that routes to the bound interface. Recorded as a possible later
  upgrade behind the same seam.
- **Build nothing — SSH into the machine and run `riker`**: zero code, but Windows has no
  Tailscale SSH server, so it requires enabling the OS OpenSSH service and a mobile terminal
  emulator driving a full TUI. It remains the documented workaround until this ships.

## Consequences

- This is CMD Riker's first deliberate network listener. The installation's "no port exposure"
  posture gets one recorded, bounded exception: opt-in per explicit Owner command, bound to the
  tailnet interface only, encrypted in transit by the VPN itself (no TLS of our own), fail closed.
  The default installation still opens no port.
- Single Owner is preserved, not weakened: remote attach is the same human on a second device,
  proven by the token; the host already broadcasts to multiple attached sockets, so no protocol
  change beyond the `authenticate` line and the lifecycle refusal is needed.
- The token is a bearer secret on the remote device; the accepted residual risk is device loss,
  mitigated by local-only rotation and by the remote surface having no lifecycle or state
  authority. Host restarts within the restart budget re-create the listener with the unchanged
  token; native toasts remain local-machine only, the remote client sees the same notice lines.
- Durable Owner-input acknowledgement is unchanged, because remote owner lines enter through the
  same `writeOwnerLine` path as pipe clients.
