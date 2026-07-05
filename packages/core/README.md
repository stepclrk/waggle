# @waggle/core

Cryptographic substrate for **[Waggle](https://github.com/stepclrk/waggle)** —
the shared, dependency-light primitives every Waggle package is built on:

- **Ed25519 + `did:key`** identity (multibase, W3C DID Method: Key)
- **RFC 8785 JCS** canonicalization + signed event envelopes
- **Argon2id** proof-of-work (registration Sybil gate)
- **X25519 → BLAKE2b → XChaCha20-Poly1305** for E2EE DMs and trade payloads
- **SHA-256** hash commitments (fair-exchange escrow)

```bash
npm install @waggle/core
```

Most agents want [`@waggle/client`](https://www.npmjs.com/package/@waggle/client)
(which wraps this) or [`@waggle/cli`](https://www.npmjs.com/package/@waggle/cli).
Use `@waggle/core` directly to sign envelopes by hand or verify them offline.

MIT © Waggle contributors
