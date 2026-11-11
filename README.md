# JacRed Direct

Find torrent sources from JacRed directly in **Nuvio TV for Samsung Tizen**. The plugin runs on your television, uses Nuvio's built-in JavaScript runtime, and returns magnet links to Nuvio's own player.

**No OpenStream Bridge, computer, separate torrent server, or debrid account is needed.** Searching still depends on the public JacRed service. Playback depends on Nuvio's built-in EngineFS, available peers, and supported media formats.

This is an independent project, not affiliated with JacRed or Nuvio.

## Install

1. On your Samsung TV, open **Nuvio TV > Plugins > Add Repository**.
2. Enter the URL below (not in the Stremio Addons screen):

   ```text
   https://raw.githubusercontent.com/aken/nuvio-jacred-direct/main/manifest.json
   ```

3. Enable **JacRed Direct** in the provider list.
4. Open a movie or TV episode and check the available sources.

The plugin requires a NuvioTVSmart build with working **PluginService/QuickJS** support on **Tizen 6.0+**. Playing torrents also requires a working **EngineFS** service in Nuvio. Not every version or television configuration necessarily supports both.

## API keys

**No API key is needed to use the public `jacred.su` endpoint.** Install the repository and enable the provider. There is no key to request, enter, or commit to GitHub.

Nuvio supplies its own TMDB API key to the plugin for metadata lookup. The plugin does not require you to configure a separate TMDB key.

The public JacRed service can change its access rules. This version does not support a private JacRed key or custom server address, and it does not store credentials. Never put a personal API key in a public manifest, source file, or repository URL.

## How it works

The plugin searches JacRed using movie or series metadata from TMDB, verifies magnet hashes, removes duplicate releases, and sorts the remaining results. When metadata is unavailable, it can fall back to JacRed's TMDB ID lookup, which depends on the external service's configuration.

For TV episodes, it checks the season and episode numbers where they can be identified. Results that may contain more than one episode are labelled **Episode selection not verified**. Nuvio's EngineFS still has to select the correct file; the plugin cannot guarantee that choice.

Source titles may be localized. The parser recognizes common season and episode formats, including localized season labels. The code works with both 40-character hexadecimal and 32-character base32 BitTorrent v1 info hashes. Torrent v2-only links and direct `.torrent` downloads are not supported.

Seeder counts are provided by JacRed and may be incomplete or outdated. A magnet is a lead, not a promise that a stream will play.

## Limitations

- This is a **Nuvio JavaScript provider**, not a Stremio addon. Use the **Plugins** screen, not **Addons**.
- No intermediary search server is needed, but Nuvio's built-in local EngineFS service is used for torrent playback.
- The plugin does not download, host or distribute video. Nuvio's P2P playback may exchange data with other peers.
- Results depend on JacRed availability, its index, and any rate limits or authentication policy.
- Multi-file torrents may play the wrong file if EngineFS cannot identify the requested episode. Verify playback rather than assuming an accurate episode match.
- The plugin does not run a background service or keep a separate search cache.

## Troubleshooting

If there are no sources, check that the provider is enabled and the PluginService runtime is healthy. Test with **TMDB 603** in Nuvio's plugin diagnostics. Confirm your TV can reach `jacred.su` and `api.themoviedb.org`. If a magnet appears but won't play, check EngineFS and the selected torrent's peers and media format. A source being listed is not proof it can be played.

## Development

Requires Node.js 20 or later. Run:

```sh
npm run verify
```

The test suite checks API error handling, metadata searches, input validation, torrent hashes, duplicate results, episode matching, multi-episode warnings, result limits and Nuvio's expected output shape. GitHub Actions runs the same checks on each push and pull request.

Automated tests use simulated API responses. **Live JacRed searches and playback on the target Samsung TV have not been verified.** To validate the integration, install the plugin, try a movie, then test two episodes from the same multi-file release and inspect whether EngineFS selected the correct file.

## License and use

Distributed under the [MIT License](LICENSE). Only access and share content that you have the rights to use. This project supplies source discovery, not permission to access copyrighted material. Local laws and your content rights still apply.

## References

- [NuvioTVSmart](https://github.com/NuvioMedia/NuvioTVSmart) - Plugin runtime and Tizen playback integration.
- [JacRed](https://github.com/jacred-fdb/jacred) - Jackett-compatible API and torrent search.
