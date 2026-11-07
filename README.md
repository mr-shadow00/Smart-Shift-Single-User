## About

Smart Shift is a minimal self hosted docker app for zimaos and casaos

it tracking your and others work flow

## How to install

1. make folders and move the files there

   /DATA/AppData/smart-shift/ ← public/, server.js, package.json, package-lock.json
   /DATA/AppData/smart-shift/ ← data/

2. use the [Smart Shift compose.yaml] on App Store → "Install a Customized App" → Docker Compose tab

3. w8

4. enjoy

## Login

The app is protected by a password. The first time you open it, it asks you to create one.
Change it any time in Profile -> Security, and log out from there too. Logins last 30 days.
The password is stored as a hash in data/auth.json. Forgot it? Stop the app, delete data/auth.json, start again, and create a new one.

Optional: set APP_PASSWORD in the compose file to fix the password there instead (then it can't be changed in the app).

# Shadow out

## Offline use

Fonts are bundled locally (public/fonts), and the compose installs packages only if node_modules is missing, so restarts work with no internet.
