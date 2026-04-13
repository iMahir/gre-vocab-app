# GRE Vocabulary App (Android)

A modern black-and-white GRE vocabulary app built with React Native.

## Data source

The app fetches words with the Fetch API from:

`https://raw.githubusercontent.com/iMahir/gre-vocab-app/refs/heads/main/GRE_Words.json`

## Features

- Deck/group selection from GRE word groups
- Separate study modes per deck:
  - **Flash Cards**: tap card to reveal definition, example, mnemonic, and synonyms
  - **Meaning Quiz**: choose the correct definition from multiple options
  - **Voice Meaning Check**: speak the meaning, transcribe with Android speech recognition, and get AI feedback
- Mark words as **Mastered**, **Reviewing**, or **Learning**
- Progress bars per deck for all three learning states
- Local progress persistence with AsyncStorage
- AI settings page to configure provider (`Gemini` or `ChatGPT`), model name, and API key
- API key stored securely via native keychain/keystore
- Black-and-white UI with improved mode and settings flows

## Run locally

```bash
npm install
npm run start
```

To run on Android:

```bash
npm run android
```

To run on iOS:

```bash
npm run ios
```

## Voice mode setup

1. Open **Settings** in the app.
2. Choose **Gemini** or **ChatGPT**.
3. Enter your model name (for example `gemini-2.0-flash` or `gpt-4o-mini`).
4. Paste your API key and tap **Save Settings**.
5. Open a deck → **Voice Meaning Check** mode → speak and evaluate.
