# JacRed Direct

Find torrent sources from JacRed in **Nuvio** on Samsung Tizen, LG webOS, and supported Android devices. One JavaScript provider handles discovery; Nuvio supplies the playback engine for each platform.

**No OpenStream Bridge, external torrent server, or debrid account is required.** Discovery depends on the public JacRed service. P2P playback depends on Nuvio's local torrent engine, network reachability, available peers, and supported media formats.

This is an independent project, not affiliated with JacRed or Nuvio.

## Compatibility

| Platform | Minimum host requirements | Torrent playback |
| --- | --- | --- |
| Samsung Tizen | Tizen 6.0+ and a NuvioTVSmart package with PluginService, Worker, and WebAssembly support | Built-in local EngineFS service |
| LG webOS | webOS 5.0+ and a NuvioTVSmart package with the bundled plugin service | Built-in local EngineFS service |
| Android / Android TV | Nuvio build with native JavaScript plugins enabled (the full Android app includes the plugin runtime) | Built-in Nuvio torrent engine |

LG webOS 5 uses lower plugin resource limits than webOS 6+. Samsung Tizen 4 and 5 do not support executable JS plugins in the official NuvioTVSmart package. Platform versions alone are not sufficient: the installed application must also expose an operational plugin runtime and local torrent playback. Android builds without the plugin module are not supported.

The repository manifest does not impose a platform restriction. It does **not** override a host's own runtime or playback capabilities. Compatibility above is based on the Nuvio source code; installation and playback have not yet been verified on real devices across these platforms.

## Install

1. Open **Nuvio > Plugins > Add Repository** on your device. Depending on the app version, Plugins may be under Settings.
2. Add the repository URL (this is **not** a Stremio Addons URL):

   ```text
   https://raw.githubusercontent.com/aken/nuvio-jacred-direct/main/manifest.json
   ```

3. Enable **JacRed Direct**. If it is already installed, refresh its repository to receive this version.
4. Open a film or episode and inspect its sources. Test torrent playback separately from source discovery.

## API keys

**No API key is needed to use the public `jacred.su` endpoint.** Install the repository and enable the provider. There is no key to request, enter, or commit to GitHub.

Nuvio supplies its own TMDB API key to the plugin for metadata lookup. The plugin does not require you to configure a separate TMDB key.

The public JacRed service can change its access rules. This version does not support a private JacRed key or custom server address, and it does not store credentials. Never put a personal API key in a public manifest, source file, or repository URL.

## How it works

The plugin searches JacRed using movie or series metadata from TMDB, verifies magnet hashes, removes duplicate releases, and sorts the remaining results. Its native source cards show the release name, tracker, reported seeders, optional leechers, size, supported quality labels, and language or voice data when JacRed reports it. It never infers audio language from the tracker name. These are text fields rendered by Nuvio; the plugin cannot create custom poster cards or change the TV interface. When a title-and-year search is empty, it retries the known titles without the year constraint while checking returned titles and years locally. When metadata is unavailable, it can fall back to JacRed's TMDB ID lookup, which depends on the external service's configuration.

For TV episodes, it checks the season and episode numbers where they can be identified. Results that may contain more than one episode are labelled **Episode selection not verified**. Nuvio's torrent engine still has to select the correct file; the plugin cannot guarantee that choice.

Source titles may be localized. The parser recognizes common season and episode formats, including localized season labels. The code works with both 40-character hexadecimal and 32-character base32 BitTorrent v1 info hashes. Torrent v2-only links and direct `.torrent` downloads are not supported.

Seeder counts are provided by JacRed and may be incomplete or outdated. A magnet is a lead, not a promise that a stream will play.

## Limitations

- This is a **Nuvio JavaScript provider**, not a Stremio addon. Use the **Plugins** screen, not **Addons**.
- No intermediary discovery server is needed. Tizen and webOS use the bundled local EngineFS service; Android uses its integrated Nuvio torrent engine.
- The plugin does not download, host or distribute video. Nuvio's P2P playback may exchange data with other peers.
- Results depend on JacRed availability, its index, and any rate limits or authentication policy.
- Multi-file torrents may play the wrong file when the playback engine cannot identify the requested episode. Verify playback rather than assuming an accurate episode match.
- The plugin does not run a background service or keep a separate search cache. Nuvio may manage client-side source caching independently.
- The native Nuvio plugin adapter does not retain an original torrent file index or supply an addon logo. Therefore, exact multi-file selection and image-based stream cards are not features this plugin can promise.

## Troubleshooting

If there are no sources, check that the provider is enabled and the local plugin runtime is healthy. Test with **TMDB 603** in the available plugin diagnostics. Confirm your device can reach `jacred.su` and `api.themoviedb.org`. If a magnet appears but will not play, check the platform torrent engine, peer connectivity, and supported media formats. A source being listed is not proof it can be played.

## Development

Requires Node.js 20 or later. Run:

```sh
npm run verify
```

The test suite checks API error handling, metadata searches, input validation, torrent hashes, duplicate results, episode matching, multi-episode warnings, result limits and Nuvio's expected output shape. GitHub Actions runs the same checks on each push and pull request.

Automated tests use simulated API responses. **Live JacRed searches and playback on Tizen, webOS, or Android have not been verified.** To validate on each platform, install the plugin, search for a movie, confirm playback, then test two different episodes from the same multi-file release and check which file the torrent engine selected.

## License and use

Distributed under the [MIT License](LICENSE). Only access and share content that you have the rights to use. This project supplies source discovery, not permission to access copyrighted material. Local laws and your content rights still apply.

## References

- [NuvioTVSmart](https://github.com/NuvioMedia/NuvioTVSmart) - Samsung Tizen and LG webOS runtimes.
- [NuvioTV](https://github.com/NuvioMedia/NuvioTV) - Android plugin runtime and integrated torrent engine.
- [JacRed](https://github.com/jacred-fdb/jacred) - Jackett-compatible API and torrent search.
