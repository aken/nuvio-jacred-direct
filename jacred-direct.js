/* JacRed Direct for Nuvio - 0.0.4
 * Runs inside Nuvio's sandboxed QuickJS plugin runtime.
 * Uses JacRed for source discovery and Nuvio's built-in P2P resolver for playback.
 * No separate bridge, personal torrent server, or debrid account is needed.
 * Use only with content you are authorized to access.
 */
(function () {
  'use strict';

  var JACRED_ENDPOINT = 'https://jacred.su/api/v2.0/indexers/all/results';
  var TMDB_ENDPOINT = 'https://api.themoviedb.org/3/';
  var API_LIMIT = 100;
  var OUTPUT_LIMIT = 80;
  var MAX_ROWS = 220;
  var MAX_MAGNET_LENGTH = 8192;
  var MAX_TITLE_LENGTH = 500;
  var MAX_TRACKERS = 24;
  var MAX_TRACKER_LENGTH = 512;
  var MAX_OUTPUT_MAGNET_LENGTH = 4096;

  function text(value) {
    return typeof value === 'string' ? value.trim() : '';

  }
  function clean(value, limit) {
    return text(value).replace(/[\u0000-\u001f\u007f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, ' ').replace(/\s+/g, ' ').slice(0, limit).trim();
  }
  function integer(value, fallback, min, max) {
    if (value === null || value === undefined || value === '') return fallback;
    var number = Number(value);
    return Number.isSafeInteger(number) && number >= min && number <= max ? number : fallback;
  }
  function settings() {
    var s = typeof SCRAPER_SETTINGS === 'object' && SCRAPER_SETTINGS && !Array.isArray(SCRAPER_SETTINGS) ? SCRAPER_SETTINGS : {};
    return {
      maxResults: integer(s.maxResults, OUTPUT_LIMIT, 1, 100),
      minSeeders: integer(s.minSeeders, 0, 0, 100000),
      allowUnknownEpisode: s.allowUnknownEpisode === true,
      allowSeasonPacks: s.allowSeasonPacks !== false
    };
  }
  function paramsUrl(base, params) {
    var pairs = [];
    Object.keys(params).forEach(function (key) {
      var value = params[key];
      if (value !== null && value !== undefined && value !== '') {
        pairs.push(encodeURIComponent(key) + '=' + encodeURIComponent(String(value)));
      }
    });
    return base + (pairs.length ? '?' + pairs.join('&') : '');
  }
  function warn(stage, error) {
    // Do not print response bodies or URLs: the TMDB key is a URL parameter.
    var status = error && integer(error.status, null, 100, 599);
    try { console.warn('[JacRed Direct] ' + stage + (status ? ' (HTTP ' + status + ')' : ' (network/format error)')); } catch (_) {}
  }
  async function getJson(url) {
    // Deliberately no X-Api-Key: Nuvio's plugin HTTP client can forward custom
    // headers to a different host when the origin responds with a redirect.
    var response = await fetch(url, { method: 'GET', headers: { Accept: 'application/json' } });
    if (!response || !response.ok) {
      var error = new Error('HTTP failure');
      error.status = response ? response.status : 0;
      throw error;
    }
    var body = await response.json();
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Non-JSON or malformed JSON result');
    return body;
  }
  function mediaKind(type) {
    var v = text(type).toLowerCase();
    return v === 'movie' ? 'movie' : v === 'series' || v === 'tv' || v === 'anime' ? 'series' : '';
  }
  function yearOf(value) {
    var match = text(value).match(/^(19|20)\d{2}/);
    return match ? Number(match[0]) : 0;
  }
  async function loadMetadata(tmdbId, kind) {
    var key = typeof TMDB_API_KEY === 'string' ? TMDB_API_KEY.trim() : '';
    if (!key) return null;
    var type = kind === 'movie' ? 'movie' : 'tv';
    var url = paramsUrl(TMDB_ENDPOINT + type + '/' + tmdbId, { api_key: key, language: 'ru-RU' });
    try {
      var data = await getJson(url);
      var title = clean(data.title || data.name, 220);
      var original = clean(data.original_title || data.original_name, 220);
      var year = yearOf(data.release_date || data.first_air_date);
      return title || original ? { title: title, original: original, year: year } : null;
    } catch (error) {
      warn('TMDB lookup failed', error);
      return null;
    }
  }
  function base32Hex(encoded) {
    if (!/^[a-z2-7]{32}$/i.test(encoded)) return '';
    var abc = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    var accumulator = 0, bits = 0, hex = '';
    encoded = encoded.toUpperCase();
    for (var i = 0; i < encoded.length; i++) {
      accumulator = (accumulator << 5) | abc.indexOf(encoded[i]);
      bits += 5;
      if (bits >= 8) {
        bits -= 8;
        var byte = (accumulator >>> bits) & 255;
        hex += (byte < 16 ? '0' : '') + byte.toString(16);
      }
    }
    return hex.length === 40 ? hex : '';
  }
  function infoHash(magnet) {
    if (typeof magnet !== 'string' || magnet.length > MAX_MAGNET_LENGTH || !/^magnet:\?/i.test(magnet)) return '';
    // Inspect only xt parameters. Percent-encoded xt values are valid too.
    var fields = magnet.slice(8).split('&');
    for (var i = 0; i < fields.length && i < 120; i++) {
      var pair = fields[i].split('=');
      if (pair.length < 2 || pair[0].toLowerCase() !== 'xt') continue;
      var value;
      try { value = decodeURIComponent(pair.slice(1).join('=')); } catch (_) { continue; }
      var match = /^urn:btih:([a-f0-9]{40}|[a-z2-7]{32})$/i.exec(value);
      if (!match) continue;
      return match[1].length === 40 ? match[1].toLowerCase() : base32Hex(match[1]);
    }
    return '';
  }
  function magnetTrackers(magnet) {
    if (!/^magnet:\?/i.test(magnet) || magnet.length > MAX_MAGNET_LENGTH) return [];
    var values = [], seen = Object.create(null);
    var fields = magnet.slice(8).split('&');
    for (var i = 0; i < fields.length && i < 120 && values.length < MAX_TRACKERS; i++) {
      var part = fields[i].split('=');
      var key = text(part[0]).toLowerCase();
      if (key !== 'tr') continue;
      var value;
      try { value = decodeURIComponent(part.slice(1).join('=')); } catch (_) { continue; }
      if (!safeTracker(value)) continue;
      var normalized = value.toLowerCase();
      if (seen[normalized]) continue;
      seen[normalized] = true;
      values.push(value);
    }
    return values;
  }
  function safeTracker(value) {
    if (typeof value !== 'string' || value.length > MAX_TRACKER_LENGTH || /[\u0000-\u0020\u007f]/.test(value)) return false;
    var match = /^(https?|udp):\/\/([^\/?#]+)(?:[\/?#]|$)/i.exec(value);
    if (!match || value.indexOf('#') !== -1) return false;
    var authority = match[2];
    if (authority.indexOf('@') !== -1 || authority.indexOf('\\') !== -1) return false;
    // Keep local/private network addresses and hostnames out of public trackers.
    var portMatch = /:(\d{1,5})$/.exec(authority);
    if (portMatch && (Number(portMatch[1]) < 1 || Number(portMatch[1]) > 65535)) return false;
    var host = authority.toLowerCase().replace(/:\d{1,5}$/, '');
    if (!host || /[^a-z0-9.\-]/i.test(host)) return false;
    if (/^\d+$/.test(host) || /^0x[\da-f]+$/i.test(host) || /\.\.|\.$/.test(host)) return false;
    if (host.split('.').some(function (label) { return /^0x[0-9a-f]+$/i.test(label) || /^0\d+$/.test(label); })) return false;
    if (/(?:^|\.)(?:localdomain|home\.arpa)$/.test(host)) return false;
    var query = value;
    try { query = decodeURIComponent(value); } catch (_) {}
    if (/[?&](?:passkey|authkey|auth|token|api_?key|password|secret|session|pass)=/i.test(query)) return false;
    if (host.split('.').some(function (label) { return !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label); })) return false;
    if (/(^|\.)(?:localhost|local|lan|home|internal|test|invalid)$/.test(host)) return false;
    if (/^(?:0|10|127|169\.254|192\.168)\./.test(host)) return false;
    var octets = host.split('.');
    if (octets.length === 4 && octets.every(function (part) { return /^\d{1,3}$/.test(part) && Number(part) <= 255; })) {
      var a = Number(octets[0]), b = Number(octets[1]);
      if (a === 0 || a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) ||
          (a === 192 && b === 168) || (a === 169 && b === 254) ||
          (a === 100 && b >= 64 && b <= 127) || a >= 224) return false;
    }
    return true;
  }
  function buildMagnet(hash, trackers) {
    var magnet = 'magnet:?xt=urn:btih:' + hash;
    for (var i = 0; i < trackers.length && i < MAX_TRACKERS; i++) {
      var next = '&tr=' + encodeURIComponent(trackers[i]);
      if (magnet.length + next.length > MAX_OUTPUT_MAGNET_LENGTH) break;
      magnet += next;
    }
    return magnet;
  }
  function mergedTrackers(primary, secondary) {
    var seen = Object.create(null), result = [];
    [primary || [], secondary || []].forEach(function (list) {
      for (var i = 0; i < list.length && result.length < MAX_TRACKERS; i++) {
        var tracker = list[i];
        var key = tracker.toLowerCase();
        if (seen[key]) continue;
        seen[key] = true;
        result.push(tracker);
      }
    });
    return result;
  }
  function sizeText(size) {
    var bytes = Number(size);
    if (!Number.isFinite(bytes) || bytes <= 0) return '';
    var units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
    var i = 0;
    while (bytes >= 1024 && i < units.length - 1) { bytes /= 1024; i++; }
    return bytes.toFixed(i ? 1 : 0) + ' ' + units[i];
  }
  function quality(title) {
    var value = title.toLowerCase().replace(/_/g, ' ');
    // Only explicit resolution evidence is sufficient. Do not infer it from size.
    var dimensions = /(?:^|[^0-9])(\d{3,4})\s*[x\u00d7]\s*(4320|2160|1440|1080|720|576|480)(?!\d)/i.exec(value);
    if (dimensions && Number(dimensions[1]) >= Number(dimensions[2]) && Number(dimensions[1]) <= Number(dimensions[2]) * 3)
      return Number(dimensions[2]) === 2160 ? '2160p' : dimensions[2] + 'p';
    if (/(?:^|[^a-z\d\u0400-\u052f])(?:4320p?(?:\d{2,3})?|8[k\u043a])(?![a-z\u0400-\u052f])/i.test(value)) return '4320p';
    if (/(?:^|[^a-z\d\u0400-\u052f])(?:2160p?(?:\d{2,3})?|4[k\u043a]|uhd)(?![a-z\u0400-\u052f])/i.test(value)) return '2160p';
    if (/(?:^|[^a-z\d])1440p?(?:\d{2,3})?(?![a-z])/i.test(value)) return '1440p';
    if (/(?:^|[^a-z\d])(?:1080p?(?:\d{2,3})?|fhd|full[ .-]?hd)(?![a-z])/i.test(value)) return '1080p';
    if (/(?:^|[^a-z\d])720p?(?:\d{2,3})?(?![a-z])/i.test(value)) return '720p';
    if (/(?:^|[^a-z\d])480p?(?:\d{2,3})?(?![a-z])/i.test(value)) return '480p';
    return 'Unknown';
  }
  function qualityRank(q) { return q === '4320p' ? 6 : q === '2160p' ? 5 : q === '1440p' ? 4 : q === '1080p' ? 3 : q === '720p' ? 2 : q === '480p' ? 1 : 0; }
  function seedCount(row) {
    if (row.Seeders === null || row.Seeders === undefined || row.Seeders === '') return -1;
    var number = Number(row.Seeders);
    return Number.isSafeInteger(number) && number >= 0 ? number : -1;
  }
  function peersCount(row) {
    if (row.Peers === null || row.Peers === undefined || row.Peers === '') return -1;
    var value = Number(row.Peers);
    return Number.isSafeInteger(value) && value >= 0 ? value : -1;
  }
  function releaseTags(title) {
    var t = title.replace(/_/g, ' ');
    var tags = [];
    var format = t.match(/\b(?:WEB-DL|WEBRip|BDRemux|BDRip|HDRip|DVDRip)\b/i);
    if (format) tags.push(format[0].toUpperCase());
    var modern = /(?:2160|4[k\u043a]|UHD|HEVC|H[ .-]?265|x265)/i.test(t);
    if (/\b(?:DoVi|Dolby[ .-]?Vision)\b/i.test(t) ||
       (/\bDV\b/i.test(t) && modern && !/\.avi(?:\b|$)/i.test(t))) tags.push('DV');
    if (/\bHDR10\+(?![a-z0-9])/i.test(t)) tags.push('HDR10+');
    else if (/\b(?:HDR10|HDR)\b/i.test(t) && !/\bSDR\b/i.test(t)) tags.push('HDR');
    if (/\b(?:HEVC|H[ .-]?265|x265)\b/i.test(t)) tags.push('HEVC');
    return tags;
  }
  function sourceAudioDetails(row) {
    var details = [];
    var langs = [], seen = Object.create(null);
    var languageMap = { ru: 'RU', rus: 'RU', russian: 'RU', en: 'EN', eng: 'EN', english: 'EN', uk: 'UKR', ukr: 'UKR', ukrainian: 'UKR', de: 'DE', deu: 'DE', german: 'DE', fr: 'FR', fra: 'FR', french: 'FR', ja: 'JA', jpn: 'JA', japanese: 'JA' };
    var items = Array.isArray(row.languages) ? row.languages : [];
    for (var i = 0; i < items.length && i < 20 && langs.length < 3; i++) {
      var code = languageMap[text(items[i]).toLowerCase()];
      if (code && !seen[code]) { seen[code] = true; langs.push(code); }
    }
    if (langs.length) details.push('Languages: ' + langs.join('/'));
    var voices = row.info && Array.isArray(row.info.voices) ? row.info.voices : [];
    var labels = [], voiceSeen = Object.create(null);
    for (var j = 0; j < voices.length && j < 20 && labels.length < 2; j++) {
      var label = clean(voices[j], 36);
      if (label && !voiceSeen[label.toLowerCase()]) { labels.push(label); voiceSeen[label.toLowerCase()] = true; }
    }
    if (labels.length) details.push('Voice: ' + labels.join(' / '));
    return details;
  }
  function normalizedWords(value) {
    return clean(value, MAX_TITLE_LENGTH).toLowerCase()
      .replace(/[^a-z0-9\u00c0-\u024f\u0370-\u052f\u0590-\u06ff\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]+/g, ' ').trim();
  }
  function matchesMetadata(row, metadata) {
    if (!metadata || (!metadata.title && !metadata.original)) return true;
    var release = ' ' + normalizedWords([row.Title, row.info && row.info.name,
      row.info && row.info.originalname].filter(Boolean).join(' ')) + ' ';
    return [metadata.title, metadata.original].some(function (alias) {
      var name = normalizedWords(alias);
      return name.length > 1 && release.indexOf(' ' + name + ' ') !== -1;
    });
  }
  function releaseYearMatches(row, year) {
    if (!year) return true;
    var recorded = row.info && Number(row.info.relased);
    if (Number.isInteger(recorded) && recorded >= 1900 && recorded <= 2100) return Math.abs(recorded - year) <= 1;
    var title = clean(row.Title, MAX_TITLE_LENGTH);
    // Ignore video dimensions such as 1920x1080: 1920 is not a release year.
    var words = [], match;
    var re = /(?:^|[^\d])((?:19|20)\d{2})(?![\dx\u00d7]\d{3,4})/g;
    while ((match = re.exec(title)) !== null) words.push(Number(match[1]));
    if (!words.length) return true;
    return words.some(function (candidate) { return Math.abs(candidate - year) <= 1; });
  }
  function parsedEpisodes(title) {
    // Use bounded title text to prevent excessive work on untrusted results.
    var t = clean(title, MAX_TITLE_LENGTH).replace(/[._]/g, ' ');
    var markers = [];
    var season = /(?:^|[^a-z\d])s(?:eason\s*)?(\d{1,2})[\s-]*e(?:pisode\s*)?(\d{1,3})(?:\s*[-~]\s*e?(\d{1,3}))?/gi;
    var numeric = /(?:^|[^\d])(\d{1,2})x(\d{1,3})(?:\s*[-~]\s*(\d{1,3}))?/gi;
    var ru = /(?:\u0441\u0435\u0437\u043e\u043d\s*(\d{1,2})\s*[,;:\- ]*\u0441\u0435\u0440(?:\u0438\u044f|\u0438\u0438|\u0438\u0439|\.)?\s*(\d{1,3})(?:\s*[-~]\s*(\d{1,3}))?)/gi;
    [season,numeric,ru].forEach(function (re) {
      var match;
      while ((match = re.exec(t)) !== null && markers.length < 30) {
        var a = Number(match[2]), b = match[3] ? Number(match[3]) : a;
        if (a > 0 && b > 0 && a <= 999 && b <= 999 && Math.abs(a - b) < 100) {
          markers.push({ s: Number(match[1]), a: Math.min(a,b), b: Math.max(a,b) });
        }
      }
    });
    // S01E02E03 or S01E02-E03 are explicit multi-episode releases.
    var consecutive = /(?:^|[^a-z\d])s(\d{1,2})[\s-]*e(\d{1,3})(?:[\s-]*e(\d{1,3})){1,6}/gi;
    var m;
    while ((m = consecutive.exec(t)) !== null) {
      var eRe = /e(\d{1,3})/gi, em;
      while ((em = eRe.exec(m[0])) !== null) markers.push({s:Number(m[1]),a:Number(em[1]),b:Number(em[1])});
    }
    return markers;
  }
  function seasonMatches(title, season, episode, row, conf) {
    var markers = parsedEpisodes(title);
    if (markers.length) {
      var matches = markers.some(function (m) { return m.s === season && episode >= m.a && episode <= m.b; });
      // An episode range or multiple distinct episode markers may represent
      // several files. Do not present its file selection as guaranteed.
      var multi = markers.some(function (m) { return m.a !== m.b; }) ||
        markers.some(function (m) { return m.s !== season || m.a !== episode || m.b !== episode; });
      return { ok: matches && (!multi || conf.allowSeasonPacks), pack: multi };
    }
    var t = clean(title, MAX_TITLE_LENGTH).replace(/[._]/g, ' ');
    var explicit = [];
    var m, re = /(?:^|[^a-z\d])s(?:eason\s*)?(\d{1,2})(?!\s*e\d)/gi;
    while ((m = re.exec(t)) !== null) explicit.push(Number(m[1]));
    re = /\u0441\u0435\u0437\u043e\u043d(?:\u044b|\u043e\u0432)?\s*(\d{1,2})(?:\s*[-~]\s*s?(\d{1,2}))?|(?:^|\s)(\d{1,2})\s*\u0441\u0435\u0437\u043e\u043d/gi;
    while ((m = re.exec(t)) !== null) {
      explicit.push(Number(m[1] || m[3]));
      if (m[2]) explicit.push(Number(m[2]));
    }
    // Standalone E05 without a season is not sufficient evidence.
    if (/(?:^|[^a-z\d])e(?:pisode\s*)?\d{1,3}/i.test(t) && !explicit.length) return {ok:false,pack:false};
    var infoSeasons = row.info && Array.isArray(row.info.seasons) ? row.info.seasons.map(Number).filter(Number.isSafeInteger) : [];
    if (explicit.length) {
      var first = explicit[0], last = explicit.length > 1 ? explicit[explicit.length - 1] : first;
      var contains = explicit.indexOf(season) !== -1 || (explicit.length > 1 && season >= Math.min(first,last) && season <= Math.max(first,last));
      return { ok: conf.allowSeasonPacks && contains, pack: true };
    }
    if (infoSeasons.length && infoSeasons.indexOf(season) !== -1) {
      return { ok: conf.allowSeasonPacks, pack: true };
    }
    return { ok: conf.allowUnknownEpisode, pack: true };
  }
  function normalize(row, kind, year, season, episode, conf, metadata) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
    var title = clean(row.Title, MAX_TITLE_LENGTH);
    if (!title || !matchesMetadata(row, metadata)) return null;
    var magnet = text(row.MagnetUri);
    if (!title || !magnet || magnet.length > MAX_MAGNET_LENGTH) return null;
    var hash = infoHash(magnet);
    if (!hash) return null;
    var seeds = seedCount(row);
    if (conf.minSeeders > 0 && seeds < conf.minSeeders) return null;
    if (kind === 'movie' && !releaseYearMatches(row, year)) return null;
    var pack = false;
    if (kind === 'series') {
      var found = seasonMatches(title, season, episode, row, conf);
      if (!found.ok) return null;
      pack = found.pack;
    }
    var q = quality(title);
    var sz = sizeText(row.Size);
    var tracker = clean(row.Tracker, 35) || 'Unknown tracker';
    var availability = seeds < 0 ? 'Seeders unknown' : seeds + (seeds === 1 ? ' seed' : ' seeds');
    var details = [tracker, sz];
    var peers = peersCount(row);
    // JacRed reports Peers, not a guaranteed leecher-only count.
    if (peers >= 0) details.push(peers + (peers === 1 ? ' peer' : ' peers'));
    details = details.concat(releaseTags(title), sourceAudioDetails(row));
    // Nuvio maps a supplied `size` field into stream.description and hides
    // stream.title on its source cards. Keep size inside title instead.
    var display = title + '\n' + details.filter(Boolean).join(' \u00b7 ');
    if (pack) display += '\nEpisode selection not verified';
    var trackers = magnetTrackers(magnet);
    return {
      url: buildMagnet(hash, trackers),
      trackers: trackers,
      infoHash: hash,
      title: display,
      name: 'JacRed \u00b7 ' + q + ' \u00b7 ' + availability + (pack ? ' \u00b7 Season pack' : ''),
      quality: q,
      seeders: seeds,
      qualityRank: qualityRank(q),
      isPack: pack
    };
  }
  function normalizeResults(rows, kind, year, season, episode, conf, metadata) {
    var distinct = Object.create(null);
    if (!Array.isArray(rows)) return [];
    for (var i = 0; i < rows.length && i < MAX_ROWS; i++) {
      var current = normalize(rows[i], kind, year, season, episode, conf, metadata);
      if (!current) continue;
      var previous = distinct[current.infoHash];
      if (!previous) { distinct[current.infoHash] = current; continue; }
      var replace = (previous.isPack && !current.isPack) ||
        (previous.isPack === current.isPack && (current.seeders > previous.seeders ||
          (current.seeders === previous.seeders && current.qualityRank > previous.qualityRank)));
      var combined = mergedTrackers(previous.trackers, current.trackers);
      if (replace) { current.trackers = combined; distinct[current.infoHash] = current; }
      else previous.trackers = combined;
    }
    return Object.keys(distinct).map(function (key) {
      var result = distinct[key];
      result.url = buildMagnet(result.infoHash, result.trackers);
      return result;
    }).sort(function (a,b) {
      return Number(a.isPack) - Number(b.isPack) || b.seeders - a.seeders || b.qualityRank - a.qualityRank || (a.title < b.title ? -1 : a.title > b.title ? 1 : 0);
    }).slice(0, conf.maxResults).map(function (r) {
      return { url: r.url, infoHash: r.infoHash, title: r.title, name: r.name, quality: r.quality };
    });
  }
  async function searchJacred(params) {
    var url = paramsUrl(JACRED_ENDPOINT, Object.assign({ limit: API_LIMIT }, params));
    var result = await getJson(url);
    if (!Array.isArray(result.Results)) throw new Error('JacRed Results property missing');
    return result.Results;
  }
  async function getStreams(tmdbId, mediaType, season, episode) {
    var id = typeof tmdbId === 'number' && Number.isSafeInteger(tmdbId) ? String(tmdbId) : text(tmdbId);
    var kind = mediaKind(mediaType), conf = settings();
    if (!/^\d{1,10}$/.test(id) || !kind) return [];
    // Season 0 denotes TV specials in the TMDB model.
    var s = integer(season, null, 0, 99), e = integer(episode, null, 1, 999);
    if (kind === 'series' && (s === null || e === null)) return [];

    var metadata = await loadMetadata(id, kind);
    var filter = { is_serial: kind === 'movie' ? 1 : 2 };
    if (kind === 'series') { filter.season = s; filter.ep = e; }
    var request = Object.assign({}, filter);
    if (metadata) {
      if (metadata.title) request.title = metadata.title;
      if (metadata.original) request.title_original = metadata.original;
      if (metadata.year) request.year = metadata.year;
    } else request.query = 'tmdb' + id;

    var results = [];
    try {
      results = normalizeResults(await searchJacred(request), kind, metadata && metadata.year, s, e, conf, metadata);
    } catch (error) {
      warn('JacRed card search failed', error);
      if (error && (error.status === 401 || error.status === 403 || error.status === 429)) return [];
    }
    if (results.length) return results;

    // A second search is justified only if the first produced no playable
    // candidates. For series, avoid JacRed's conservative season filter on
    // the fallback because it can exclude valid non-SxxExx naming schemes.
    var fallback = Object.assign({}, filter);
    if (kind === 'series') { delete fallback.season; delete fallback.ep; }
    if (metadata) {
      if (metadata.title) fallback.title = metadata.title;
      if (metadata.original) fallback.title_original = metadata.original;
      // A valid title with a mismatched catalogue year can produce a false
      // negative. Retry without the server year filter, and validate the
      // release year and title locally before returning any candidate.
    } else if (kind === 'series') fallback.query = 'tmdb' + id;
    else return [];
    // A movie without metadata has already made precisely this ID query.
    if (JSON.stringify(fallback) === JSON.stringify(request)) return [];
    try { return normalizeResults(await searchJacred(fallback), kind, metadata && metadata.year, s, e, conf, metadata); }
    catch (error) { warn('JacRed fallback search failed', error); return []; }
  }
  module.exports.getStreams = getStreams;
})();
