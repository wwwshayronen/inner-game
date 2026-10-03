# iOS signing setup

Android builds without secrets.

For a device-installable iOS Ad Hoc IPA, add these GitHub Actions secrets under **Settings → Secrets and variables → Actions**:

- `IOS_TEAM_ID`
- `IOS_PROFILE_NAME`
- `IOS_CERTIFICATE_BASE64`
- `IOS_CERTIFICATE_PASSWORD`
- `IOS_PROVISION_PROFILE_BASE64`
- `IOS_KEYCHAIN_PASSWORD`

The target iPhone UDID must be included in the Ad Hoc provisioning profile.

Then run **Actions → Build Inner Game mobile apps → Run workflow** and download the artifacts from the completed run.
