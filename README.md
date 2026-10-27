# BriteBin CustomerVision

CustomerVision keeps the workflow simple:

1. Enter an email address and send a one-time verification code.
2. Enter the six-digit code received by that mailbox.
3. Sign in with the BriteBin password.
4. Search for a bin by serial number.
5. View the full unit record and complete latest reading.

## First launch

On first launch, CustomerVision asks for the sender Gmail address and its Google app password and checks it with Gmail. The app password is stored only in the local `.env` file and is not placed in the application code.

Do not use the normal Gmail password. Google requires Two-Step Verification before an app password can be created. A Google Workspace administrator can disable app passwords; if the option is unavailable, ask the Workspace administrator to enable an approved SMTP method.

## Launch

- Windows: double-click **START_CUSTOMERVISION.bat**
- macOS: double-click **START_CUSTOMERVISION.command**
- Linux: run **START_CUSTOMERVISION.sh**

The dashboard opens in the default browser. Keep the launcher window open while using it.

## Changing the sender password

Run the matching **SETUP_EMAIL** file. It replaces the local SMTP settings after checking the new app password.

## Requirements

Node.js LTS must be installed. All application packages are included, so normal users do not need to run `npm install`.

## Email verification behaviour

- Codes contain six digits and expire after 10 minutes.
- A code can be requested once per minute for the same address.
- Incorrect codes are limited to five attempts.
- An address is marked verified only after the code is entered successfully.
- The BriteBin login endpoint is not called until server-side verification has succeeded.
- CustomerVision does not store the BriteBin password.

## Bin information

The result view includes:

- Unit ID, latest fill level, battery voltage, and reading time
- Every field returned by the unit-details endpoint
- Every field returned in the latest reading
- Complete original JSON for the unit and reading
- Additional raw API records from the serial check and unit search

## Developer commands

```bash
npm install
npm run lint
npm run build
npm start
```

The complete verification flow runs through `npm start`; the Vite-only development server does not send verification email.


## Optional email verification

The sign-in screen includes a checked **Verify this email address before signing in** box. Leave it checked to send and confirm a one-time code. Untick it to sign in directly with the BriteBin email and password without sending a code.
