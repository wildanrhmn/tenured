# sputnikdao2.wasm

The exact Sputnik DAO contract the testnet factory deploys today, used by the
sandbox tests so they run against production code rather than a mock.

Fetched with `sputnikv2.testnet.get_code({"code_hash": "AA4nA45vauiac3jdVwJTzSdUP3oj2r1fDaPAb2mHdgcH"})`.
That hash is what `sputnikv2.testnet.get_default_code_hash()` returned on 2026-11-10, and it is
the base58 sha256 of this file:

```sh
python3 -c "import hashlib,sys;print(hashlib.sha256(open('contracts/res/sputnikdao2.wasm','rb').read()).hexdigest())"
```
