# Nota license tool (vendor only)

Issues the lifetime licenses that unlock Nota on a shop's main PC. It is plain Node code, with no dependencies, and runs on **your** PC. It never ships with the app. The **private key never enters this repo**.

## 1. Create the key pair (once)

```
node tools/license-gen/license-gen.js keygen --out D:\nota-keys
```

- Writes `private.pem` and `public.pem` into that folder. It refuses to overwrite an existing key.
- Put the folder **outside the repo**, on a USB stick you keep offline, **and make a second backup copy** (another USB or a safe). If the private key is lost you cannot issue licenses for any shop, and if it leaks anyone can.
- `*.pem`, `*.key`, `issued-licenses.csv` and `tools/license-gen/keys/` are git-ignored, and a backend test fails if a private key shows up anywhere in the repo.

## 2. Put the public key into the code (once)

Open `nota-backend/src/license/keys.js` and replace the whole `PRODUCTION_PUBLIC_KEY_PEM` block (the one containing `NOTA_PLACEHOLDER_REPLACE_WITH_PRODUCTION_PUBLIC_KEY`) with the contents of `public.pem`:

```js
const PRODUCTION_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEA....
-----END PUBLIC KEY-----`;
```

- The public key is compiled into the app. No setting, file or environment variable can replace it.
- **Build guard:** `npm run offline:stage` (and so `npm run electron:build:win:offline`, which runs it) stops with an error while the placeholder is still there, so you cannot ship an app that accepts no license. It also stops if the staged backend still has the test key, the test flag or any private key.
- To try a build without your real key, make a throwaway pair with `keygen` in a temp folder, put its public key in `keys.js`, build, and then **put the placeholder back** (never commit a throwaway key).
- Only the public key goes in the repo. Commit that change yourself.

## 3. Issue a license for a shop

1. On the shop's main PC, install Nota. The activation screen shows the **Machine ID** (`XXXX-XXXX-XXXX-XXXX`) with a copy button. The shop sends it to you.
2. Issue the license:

```
node tools/license-gen/license-gen.js issue --key D:\nota-keys\private.pem ^
  --machine 1A2B-3C4D-5E6F-7A8B --shop "اسم المحل" --shop-en "Shop Name" ^
  --max-clients 3 --out nota.lic
```

   - `--shop` is the name the app shows and prints. It is locked to the license, so check the spelling.
   - `--shop-en` is optional.
   - `--max-clients` is how many **client PCs** may pair with the main PC (`0` = main PC only).
   - It prints the license text (one line starting with `NOTA1.`), writes `nota.lic` if you passed `--out`, and appends a line to `issued-licenses.csv` **next to the private key** (licenseId, date, shop, machine, maxClients).
3. Send the shop the text or the `nota.lic` file. They paste it into the activation screen or load the file.

Every license is **lifetime**: no expiry, no trial, no subscription. The first shop gets one exactly like any other, issued at no cost.

## Check a license

```
node tools/license-gen/license-gen.js verify --pub D:\nota-keys\public.pem nota.lic
```

Shows what is inside and whether the signature is valid.

## Good to know

- **A Windows reinstall changes the Machine ID.** The shop sends the new ID and you issue a new license. Their data on disk is untouched.
- Copying the app, the data folder or the license file to another PC does not work: the license is tied to the Machine ID of the PC it was issued for.
- To replace a license (new Machine ID, more client PCs), issue a new one and the shop owner uses "replace license" in the shop profile.
