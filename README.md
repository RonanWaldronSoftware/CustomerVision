# CustomerVision — Bin Information Viewer

CustomerVision is a browser-based tool for looking up detailed information about a connected waste bin using its serial number. It provides a focused way for authorized users to sign in, find a bin, and review its recorded status without navigating the full management application.

The tool connects to the existing BriteBin service. It does not independently collect sensor readings or maintain its own bin database.

## What it does

| Function | Description |
| --- | --- |
| Account sign-in | Uses an existing BriteBin email address and password to access available bin records. |
| Optional email verification | Can send a six-digit code to the user's email address and request confirmation before sign-in. Users can also choose to skip this step. |
| Serial-number search | Finds a bin using its registered serial number. |
| Bin overview | Displays key information, including bin ID, fill level, battery voltage, and the latest reading time when available. |
| Detailed records | Displays all returned bin details and the latest available sensor reading. |
| Original data | Provides expandable views of the original information returned by the BriteBin service for troubleshooting or further inspection. |

The information displayed depends on what the connected service returns and what the signed-in account is permitted to access.

## How it works

1. The user opens CustomerVision in a web browser.
2. They enter their BriteBin account email address and choose whether to verify access to that email inbox.
3. If verification is selected, CustomerVision emails a one-time code that the user enters before continuing.
4. The user signs in with their existing BriteBin password.
5. After sign-in, they search for a bin by serial number.
6. CustomerVision requests the matching bin record and recent sensor information from the BriteBin service, then displays the results.

CustomerVision acts as a viewing interface. The underlying service remains responsible for account authentication, stored bin data, and access to records.

## Optional email verification

Email verification is selected by default but can be turned off on the sign-in screen. When enabled:

- A six-digit code is sent to the entered email address.
- The code expires after **10 minutes**.
- A new code cannot be requested for the same address more than once per minute.
- Up to **five incorrect attempts** are allowed for a code.
- Verification is checked before the account sign-in request is forwarded.

The server also limits email-code requests from an individual network address. Verification records are held temporarily in memory, rather than in a separate database.

**Note:** Because the user can disable email verification, it is an optional check of mailbox access, not mandatory two-factor authentication. The BriteBin password is still required to sign in.

## Information shown for a bin

After a successful serial-number lookup, the interface shows:

- Basic identification and status information.
- Fill level, battery voltage, and reading time, when returned.
- The complete bin details record.
- The latest reading found by the application's recent-readings request (which searches the preceding 30 days).
- Expandable original records for closer inspection.

If no recent reading is available, the application can still show the bin details returned by the service.

## Requirements

- A computer with **Node.js** installed.
- A modern web browser.
- Network access to the configured BriteBin service.
- A valid BriteBin user account with permission to view the relevant bins.
- For email verification: a configured SMTP email account. The supplied setup process supports Gmail using a Google app password.

The application uses React for its browser interface and a Node.js server for email verification, serving the application, and forwarding requests to the BriteBin service.

## Running the application

The package includes launchers for different operating systems:

| System | Launcher |
| --- | --- |
| Windows | `START_CUSTOMERVISION.bat` |
| macOS | `START_CUSTOMERVISION.command` |
| Linux | `START_CUSTOMERVISION.sh` |

On first launch, the included setup process asks for the Gmail address that will send verification codes and its Google app password. The sender address is not fixed in the software. Keep the launcher running while using the web application.

The application server uses port **4173** by default and opens the local page in a browser. The service address can be configured through `BRITEBIN_API_URL`; the default in the supplied code points to the BriteBin API.

The development-only command `npm run dev` runs the website interface but does not by itself provide the complete email-verification service.

## Configuration and privacy

Email settings are read from a local `.env` file. The package includes `.env.example` as a configuration template. Do not publish actual email app passwords or other credentials in a GitHub repository.

CustomerVision does not deliberately store the BriteBin account password in its own database. The password is submitted for authentication through the application's server to the existing BriteBin service. Email verification state is temporary and is lost when the server restarts.

## Project scope

CustomerVision is designed for **viewing and inspecting existing bin records**. The supplied code does not implement bin editing, collection route management, historical reporting, or its own long-term data storage.

