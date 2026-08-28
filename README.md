# Deck UI Restored

Deck UI Restored is a Decky Loader plugin that fixes Steam Deck interface problems caused by Steam updates. Each fix has its own switch, so you can use only the ones you want.

## What it fixes

### Mini achievements

Steam stopped showing the small achievement progress bar beside Play Time on game details pages. Deck UI Restored brings that bar back by using Steam's own achievement display and live progress data.

![Restored achievement bar](assets/achievement-bar-restored.png)

The bar still follows Steam's normal rules. It stays hidden when Steam has no achievement total, and it does not invent progress for games with missing data.

### Home carousel title

The first game in the Home carousel can sometimes stay highlighted after controller focus moves to another game. Its old title, glow, and raised tile can remain on screen.

The optional Home Carousel Title Fix clears that stuck state while you move through the carousel. It keeps the appearance chosen by Steam and your other CSSLoader themes.

## Using the plugin

Open **Quick Access → Decky → Deck UI Restored**.

The panel contains:

- **Restore Mini Achievements** — turns the achievement progress bar on or off. It is on by default.
- **Home Carousel Title Fix** — fixes the stuck Home carousel highlight. It is off by default.
- **Settings** — includes optional debug logging for troubleshooting.
- **Updates** — checks for new versions and lets Decky install them.
- **Versions** — shows the installed plugin, Decky Loader, and SteamOS versions.

All controls can be used with the Steam Deck controls.

## Updates

Automatic update checks are on by default. You can also open the **Updates** panel and choose **Check now**.

The stable channel is recommended for normal use. Development releases are available for testing, but they may contain unfinished changes or regressions.

When an update is available, Decky shows its normal installation confirmation before making changes.

## Install on Steam Deck

Decky Loader must already be installed.

### Desktop installer

In SteamOS Desktop Mode:

1. Download `Decky-SteamAchievements Installer.zip`.
2. Extract the ZIP directly onto the Desktop.
3. Keep the extracted `Decky-SteamAchievementsInstaller` folder beside `Install Decky-SteamAchievements`.
4. Double-click **Install Decky-SteamAchievements**.
5. Review the details and approve the administrator prompt.
6. Return to Gaming Mode when installation finishes.

If KDE marks the launcher as untrusted, review it and choose **Trust and Launch**.

### Install the plugin ZIP through Decky

You can also install `Decky-SteamAchievements.zip` with Decky's built-in ZIP installer:

1. Place `Decky-SteamAchievements.zip` in the Steam Deck's Downloads folder.
2. Open **Quick Access → Decky → Settings → General**.
3. Under **Other**, enable **Developer mode**.
4. Open **Developer → Third-Party Plugins**.
5. Choose **Install Plugin from ZIP File**, select the ZIP, and approve the installation.

Use `Decky-SteamAchievements.zip` for this method. Do not select `Decky-SteamAchievements Installer.zip`; that file is the Desktop installer bundle.

Decky shows the installed plugin as **Deck UI Restored**. The download and installed folder keep the older `Decky-SteamAchievements` name so existing installations can update safely.

## Development

Technical background, build instructions, packaging, testing, and release details are in [DEVELOPER.md](DEVELOPER.md).

## License

GPL-3.0-or-later.
