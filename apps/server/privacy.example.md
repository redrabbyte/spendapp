<!-- version: placeholder -->
# Privacy policy — PLACEHOLDER

**This is not a privacy policy.** It is the file the app falls back to when no
real one has been installed, so that registration is never silently
consent-free. Replace it before letting anyone but yourself sign up.

The real text is deliberately not in the repository. Put it at the path in
`PRIVACY_PATH` (the deploy scripts point that at `shared/privacy.md`, alongside
`.env` and the receipts), and the running app picks it up without a rebuild.

## Versioning

The first line may carry a version marker:

```
<!-- version: 2026-08-10 -->
```

Whatever follows `version:` is stored against every account that accepts this
text, and changing it asks everyone to accept again. Leave the marker out and
the version becomes a hash of the file, so *any* edit — including fixing a
typo — triggers re-consent. Set it explicitly and you decide what counts as a
substantive change.

**If you start from this file, change the marker.** The literal value
`placeholder` is how the server recognises that no real policy is installed:
while it is there, registration shows a warning and existing accounts are never
interrupted to accept anything. Leaving it on real text would mean nobody is
ever asked.

## What a real policy here would need to cover

Notes for whoever writes it, not legal advice:

- Who the controller is, and how to reach them.
- What is stored. Note that expenses, payments, comments and receipt images are
  end-to-end encrypted and unreadable to the operator, while usernames, display
  names, group names, group membership, timestamps and entry sizes are not.
- The lawful basis for each of those, and how long they are kept.
- That a forgotten password destroys access to the encrypted data
  irrecoverably, because no recovery copy of the key exists.
- What the app puts on the reader's own device, and why none of it is asked
  about. The session cookie, the settings in local storage, the `spendapp`
  database holding a decrypted copy of their groups, and the cache holding the
  app and recent receipts. Consent is a separate obligation from transparency:
  none of that storage needs permission, because each part is what makes a
  service the user asked for work — but they still have to be told it is there.
  No banner is warranted while the page contacts no third party, loads no
  analytics and carries no advertising; adding any one of those changes the
  answer.
- Web push endpoints, if notifications are enabled, and the third parties the
  browser vendor routes them through.
- How to exercise access, rectification, erasure and portability — including
  that leaving a group deletes its data once the last member goes.
