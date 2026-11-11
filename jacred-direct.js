/* JacRed Direct for Nuvio - 0.0.12
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
    return v === 'movie' ? 'movie' : v === 'series' || v === 'tv' || v === 'anime' || v === 'other' ? 'series' : '';
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
  // Parse address literals without relying on browser URL or DNS APIs in QuickJS.
  // Only publicly routable IPv6 unicast is retained. Private, link-local,
  // loopback, multicast and documentation addresses are not tracker endpoints.
  function globalIpv6(value) {
    if (!/^[0-9a-f:]+$/i.test(value)) return false;
    var double = value.indexOf('::');
    if (double !== -1 && value.indexOf('::', double + 2) !== -1) return false;
    var groups;
    if (double === -1) {
      groups = value.split(':');
      if (groups.length !== 8) return false;
    } else {
      var left = value.slice(0, double);
      var right = value.slice(double + 2);
      var before = left ? left.split(':') : [];
      var after = right ? right.split(':') : [];
      if (before.length + after.length >= 8) return false;
      groups = before.concat(Array(8 - before.length - after.length).fill('0'), after);
    }
    if (groups.length !== 8 || groups.some(function (group) { return !/^[0-9a-f]{1,4}$/i.test(group); })) return false;
    var a = parseInt(groups[0], 16), b = parseInt(groups[1], 16);
    if (a < 0x2000 || a >= 0x4000) return false;
    if (a === 0x2001 && b === 0x0db8) return false;
    return true;
  }
  function safeTracker(value) {
    if (typeof value !== 'string' || value.length > MAX_TRACKER_LENGTH || /[\u0000-\u0020\u007f]/.test(value)) return false;
    var match = /^(https?|udp):\/\/([^\/?#]+)(?:[\/?#]|$)/i.exec(value);
    if (!match || value.indexOf('#') !== -1) return false;
    var authority = match[2];
    if (authority.indexOf('@') !== -1 || authority.indexOf('\\') !== -1) return false;
    // Keep local/private network addresses and hostnames out of public trackers.
    // IPv6 authorities must be bracketed: [2001:4860::1]:6969.
    // Never accept ambiguous unbracketed forms or IPv4-mapped literals.
    if (authority.charAt(0) === '[') {
      var literal = /^\[([0-9a-f:]+)\](?::(\d{1,5}))?$/i.exec(authority);
      if (!literal || !globalIpv6(literal[1]) ||
          (literal[2] && (Number(literal[2]) < 1 || Number(literal[2]) > 65535))) return false;
      var rawQuery = value;
      try { rawQuery = decodeURIComponent(value); } catch (_) {}
      return !/[?&](?:passkey|authkey|auth|token|api_?key|password|secret|session|pass)=/i.test(rawQuery);
    }
    var portMatch = /:(\d{1,5})$/.exec(authority);
    if (portMatch && (Number(portMatch[1]) < 1 || Number(portMatch[1]) > 65535)) return false;
    var host = authority.toLowerCase().replace(/:\d{1,5}$/, '');
    // Unqualified hostnames may resolve through a LAN search suffix or LLMNR.
    // Numeric-looking dotted hosts must be valid IPv4 addresses, not DNS aliases.
    if (!host || host.indexOf('.') === -1 || /[^a-z0-9.\-]/i.test(host)) return false;
    if (/^\d+(?:\.\d+)+$/.test(host)) {
      var numericParts = host.split('.');
      if (numericParts.length !== 4 || numericParts.some(function (part) { return !/^\d{1,3}$/.test(part) || Number(part) > 255; })) return false;
    }
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
      // Reject non-global IPv4 destinations, including documentation and
      // benchmark ranges. Tracker URLs are untrusted external input.
      var c = Number(octets[2]);
      if (a === 0 || a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) ||
          (a === 192 && (b === 0 && (c === 0 || c === 2) || b === 168 || b === 88 && c === 99)) ||
          (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127) ||
          (a === 198 && (b === 18 || b === 19 || b === 51 && c === 100)) ||
          (a === 203 && b === 0 && c === 113) || a >= 224) return false;
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
  function shortReleaseLabel(title, metadata) {
    // A common JacRed heading contains a verbose [year, countries, genres,
    // technical details] block. Those details are rendered separately.
    // Preserve all original source data for validation before calling this.
    var label = title;
    var bracket = /\s+\[(?:19|20)\d{2}(?:[,;\s\]])/.exec(label);
    if (bracket) label = label.slice(0, bracket.index).trim();
    // Some trackers put the director's bilingual credit between the title
    // and the catalogue block. It is not a release/encoding distinction.
    if (bracket) label = label.replace(/\s+\([^()]{8,}\s+\/\s+[^()]{5,}\)$/, '').trim();
    if (label.length > 96) {
      // Avoid cutting inside a surrogate pair, even with a malformed source.
      label = label.slice(0, 93).replace(/[\uD800-\uDBFF]$/, '').trimEnd() + '...';
    }
    var year = metadata && metadata.year;
    if ((!Number.isInteger(year) || year < 1900 || year > 2100) && bracket) {
      var found = /\[(19|20)\d{2}/.exec(bracket[0]);
      year = found ? Number(found[0].slice(1)) : 0;
    }
    if (year >= 1900 && year <= 2100 && !new RegExp('(?:^|[^0-9])' + year + '(?![0-9])').test(label))
      label += ' (' + year + ')';
    return label;
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
    // Prefer explicit dimensions. A bare four-digit resolution label must end
    // at a token boundary; 21601080 is not a 2160p label.
    var dimensions = /(?:^|[^0-9])(\d{3,4})\s*[x\u00d7]\s*(4320|2160|1440|1080|720|576|480)(?!\d)/i.exec(value);
    if (dimensions && Number(dimensions[1]) >= Number(dimensions[2]) && Number(dimensions[1]) <= Number(dimensions[2]) * 3)
      return Number(dimensions[2]) === 2160 ? '2160p' : dimensions[2] + 'p';
    var labels = [
      ['4320p', /(?:^|[^a-z\d\u0400-\u052f])(?:4320(?:p(?:\d{2,3})?(?:fps|hz)?)?|8[k\u043a])(?![a-z\d\u0400-\u052f])/i],
      ['2160p', /(?:^|[^a-z\d\u0400-\u052f])(?:2160(?:p(?:\d{2,3})?(?:fps|hz)?)?|4[k\u043a]|uhd)(?![a-z\d\u0400-\u052f])/i],
      ['1440p', /(?:^|[^a-z\d])1440(?:p(?:\d{2,3})?(?:fps|hz)?)?(?![a-z\d])/i],
      ['1080p', /(?:^|[^a-z\d])(?:1080(?:p(?:\d{2,3})?(?:fps|hz)?)?|fhd|full[ .-]?hd)(?![a-z\d])/i],
      ['720p', /(?:^|[^a-z\d])720(?:p(?:\d{2,3})?(?:fps|hz)?)?(?![a-z\d])/i],
      ['480p', /(?:^|[^a-z\d])480(?:p(?:\d{2,3})?(?:fps|hz)?)?(?![a-z\d])/i]
    ];
    // An ambiguous release title may describe the source and the actual
    // encode at different resolutions. Never advertise the higher one as fact.
    var detected = [];
    for (var i = 0; i < labels.length; i++) if (labels[i][1].test(value)) detected.push(labels[i][0]);
    return detected.length === 1 ? detected[0] : 'Unknown';
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
    if (format) {
      var formats = { 'web-dl':'WEB-DL', webrip:'WEBRip', bdremux:'BDRemux', bdrip:'BDRip', hdrip:'HDRip', dvdrip:'DVDRip' };
      tags.push(formats[format[0].toLowerCase()]);
    }
    var modern = /(?:2160|4[k\u043a]|UHD|HEVC|H[ .-]?265|x265)/i.test(t);
    if (/\b(?:DoVi|Dolby[ .-]?Vision)\b/i.test(t) ||
       (/\bDV\b/i.test(t) && modern && !/\.avi(?:\b|$)/i.test(t))) tags.push('DV');
    if (/\bHDR10\+(?![a-z0-9])/i.test(t)) tags.push('HDR10+');
    else if (/\b(?:HDR10|HDR)\b/i.test(t) && !/\bSDR\b/i.test(t)) tags.push('HDR');
    if (/\b(?:HEVC|H[ .-]?265|x265)\b/i.test(t)) tags.push('HEVC');
    return tags;
  }
  function sourceAudioDetails(row) {
    // Keep the entire audio summary to one reasonably short TV-card line.
    // Language codes and voices are displayed only when explicitly reported.
    var langs = [], langSeen = Object.create(null);
    var languageMap = { ru: 'RU', rus: 'RU', russian: 'RU', en: 'EN', eng: 'EN', english: 'EN', uk: 'UKR', ukr: 'UKR', ukrainian: 'UKR', de: 'DE', deu: 'DE', german: 'DE', fr: 'FR', fra: 'FR', french: 'FR', ja: 'JA', jpn: 'JA', japanese: 'JA' };
    var items = Array.isArray(row.languages) ? row.languages : [];
    for (var i = 0; i < items.length && i < 20 && langs.length < 3; i++) {
      var code = languageMap[text(items[i]).toLowerCase()];
      if (code && !langSeen[code]) { langSeen[code] = true; langs.push(code); }
    }
    var prefix = langs.length ? langs.join('/') : '';
    var voices = row.info && Array.isArray(row.info.voices) ? row.info.voices : [];
    var labels = [], voiceSeen = Object.create(null);
    for (var j = 0; j < voices.length && j < 256; j++) {
      var label = clean(voices[j], 100);
      if (/[\uD800-\uDBFF]$/.test(label)) label = label.slice(0, -1);
      var key = label.toLowerCase();
      if (label && !voiceSeen[key]) { labels.push(label); voiceSeen[key] = true; }
    }
    if (!labels.length) return prefix;
    var header = (prefix ? prefix + ' \u00b7 ' : '') + 'Voices: ';
    var chosen = [];
    for (var k = 0; k < labels.length && chosen.length < 4; k++) {
      var codepoints = Array.from(labels[k]);
      var candidate = codepoints.length > 28 ? codepoints.slice(0, 27).join('').trim() + '\u2026' : labels[k];
      var rest = labels.length - k - 1;
      var suffix = voices.length > 256 && labels.length > 4 ? ' +more' : (rest ? ' +' + rest : '');
      var attempt = header + chosen.concat(candidate).join(' / ') + suffix;
      if (attempt.length > 72) break;
      chosen.push(candidate);
    }
    var omitted = labels.length - chosen.length;
    // A first name can never be larger than the budget after shortening.
    return header + chosen.join(' / ') + (voices.length > 256 && omitted > 0 ? ' +more' : (omitted ? ' +' + omitted : ''));
  }
  function normalizedWords(value) {
    return clean(value, MAX_TITLE_LENGTH).toLowerCase()
      .replace(/[^a-z0-9\u00c0-\u024f\u0370-\u052f\u0590-\u06ff\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]+/g, ' ').trim();
  }
  function matchesMetadata(row, metadata) {
    if (!metadata || (!metadata.title && !metadata.original)) return true;
    // Catalog aliases alone cannot prove that the returned torrent matches.
    // The release title must contain a known title; metadata fields are hints.
    var release = ' ' + normalizedWords(row.Title) + ' ';
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
    var season = /(?:^|[^a-z\d])s(?:eason\s*)?(\d{1,2})[\s-]*e(?:p(?:isode)?)?\s*(\d{1,3})(?!\d)(?:\s*[-~]\s*e?(\d{1,3})(?!\d))?/gi;
    var numeric = /(?:^|[^\d])(\d{1,2})x(\d{1,3})(?!\d)(?:\s*[-~]\s*(\d{1,3})(?!\d))?/gi;
    var ru = /(?:\u0441\u0435\u0437\u043e\u043d\s*(\d{1,2})\s*[,;:\- ]*\u0441\u0435\u0440(?:\u0438\u044f|\u0438\u0438|\u0438\u0439|\.)?\s*(\d{1,3})(?!\d)(?:\s*[-~]\s*(\d{1,3})(?!\d))?)/gi;
    [season,numeric,ru].forEach(function (re) {
      var match;
      while ((match = re.exec(t)) !== null && markers.length < 30) {
        var a = Number(match[2]), b = match[3] ? Number(match[3]) : a;
        // Do not turn reversed, overlong or zero-valued ranges into valid
        // episode spans. A sentinel prevents a season-only fallback.
        if (a >= 1 && b >= a && b <= 999 && b - a < 100)
          markers.push({ s: Number(match[1]), a: a, b: b });
        else markers.push({ s: Number(match[1]), a: 0, b: 0 });
      }
    });
    // S01E02E03 or S01E02-E03 are explicit multi-episode releases.
    var consecutive = /(?:^|[^a-z\d])s(\d{1,2})[\s-]*e(\d{1,3})(?!\d)(?:[\s-]*e(\d{1,3})(?!\d)){1,6}/gi;
    var m;
    while ((m = consecutive.exec(t)) !== null) {
      var eRe = /e(\d{1,3})/gi, em;
      while ((em = eRe.exec(m[0])) !== null) markers.push({s:Number(m[1]),a:Number(em[1]),b:Number(em[1])});
    }
    // Comma-separated episode lists (S01E02,E04) denote multiple files.
    var list = /(?:^|[^a-z\d])s(\d{1,2})[\s-]*e(\d{1,3})(?!\d)((?:\s*[,;&+]\s*e?\d{1,3}(?!\d)){1,10})/gi;
    while ((m = list.exec(t)) !== null) {
      var values = [m[2]].concat((m[3].match(/\d{1,3}(?!\d)/g) || []));
      for (var j = 0; j < values.length && markers.length < 40; j++)
        markers.push({ s: Number(m[1]), a: Number(values[j]), b: Number(values[j]) });
    }
    // Named English/Russian episode lists, such as "Season 1: Episodes 1-3, 5".
    // A specific episode range must take priority over a season-wide guess.
    var named = /(?:^|[^a-z\d])(?:season|s|\u0441\u0435\u0437\u043e\u043d)\s*(\d{1,2})(?!\d)\s*[,;:.\-/]?\s*(?:episodes?|eps?|e|\u044d\u043f\u0438\u0437\u043e\u0434(?:\u044b|\u0430|\u043e\u0432)?|\u0441\u0435\u0440(?:\u0438\u044f|\u0438\u0438|\u0438\u0439)?)\s*[:.]?\s*(\d{1,3})(?!\d)((?:\s*[-~,;&+]\s*(?:e(?:p)?)?\d{1,3}(?!\d)){0,10})/gi;
    while ((m = named.exec(t)) !== null && markers.length < 40) {
      var namedSeason = Number(m[1]), first = Number(m[2]);
      if (first < 1 || first > 999) { markers.push({ s: namedSeason, a: 0, b: 0 }); continue; }
      var last = first, items = [], token;
      var suffix = /([-~,;&+])\s*(?:e(?:p)?)?(\d{1,3})(?!\d)/gi;
      while ((token = suffix.exec(m[3])) !== null && items.length < 10) {
        var next = Number(token[2]);
        if (next < 1 || next > 999) continue;
        if (token[1] === '-' || token[1] === '~') {
          if (next < last || next - last >= 100) { items = []; last = -1; break; }
          items.push({ s: namedSeason, a: last, b: next });
        } else items.push({ s: namedSeason, a: next, b: next });
        last = next;
      }
      if (last === -1) {
        // An explicit but invalid interval must not become a season-wide match.
        markers.push({ s: namedSeason, a: 0, b: 0 });
      } else {
        // Do not discard the initial number when subsequent entries exist.
        markers.push({ s: namedSeason, a: first, b: first });
        for (var k = 0; k < items.length && markers.length < 50; k++) markers.push(items[k]);
      }
    }
    // Episode labels AFTER the numbers are common in release names:
    // "Season 1: 2-4 episodes" or "1 \u0441\u0435\u0437\u043e\u043d 2,4 \u0441\u0435\u0440\u0438\u0438". Without these
    // patterns, an explicit episode list can be misread as a full-season pack.
    // Keep parsing bounded and fail closed on reversed or invalid ranges.
    function appendPostfix(seasonNumber, firstNumber, suffix) {
      var ss = Number(seasonNumber), first = Number(firstNumber);
      if (first < 1 || first > 999) { markers.push({ s:ss, a:0, b:0 }); return; }
      var added = [{ s:ss, a:first, b:first }], last = first, token;
      var tokenPattern = /([-~,;&+])\s*(?:e(?:p)?)?(\d{1,3})(?!\d)/gi;
      while ((token = tokenPattern.exec(suffix)) !== null) {
        var next = Number(token[2]);
        if (next < 1 || next > 999 ||
            ((token[1] === '-' || token[1] === '~') && (next < last || next - last >= 100))) {
          markers.push({ s:ss, a:0, b:0 });
          return;
        }
        if (token[1] === '-' || token[1] === '~') added.push({ s:ss, a:last, b:next });
        else added.push({ s:ss, a:next, b:next });
        last = next;
      }
      for (var index = 0; index < added.length && markers.length < 50; index++) markers.push(added[index]);
    }
    var ending = '(?:episodes?|eps?|\u0441\u0435\u0440(?:\u0438\u044f|\u0438\u0438|\u0438\u0439)|\u044d\u043f\u0438\u0437\u043e\u0434(?:\u0430|\u044b|\u043e\u0432)?)';
    var postfixTail = '(\\d{1,3})(?!\\d)((?:\\s*[-~,;&+]\\s*(?:e(?:p)?)?\\d{1,3}(?!\\d)){0,10})\\s+' + ending + '(?![a-z\\u0400-\\u052f])';
    var namedSeasonPostfix = new RegExp('(?:^|[^a-z\\d\\u0400-\\u052f])(?:seasons?|s|\\u0441\\u0435\\u0437\\u043e\\u043d(?:\\u0430)?)\\s*(\\d{1,2})(?!\\d)[\\s,;:.\\-/()]+\\s*' + postfixTail, 'gi');
    var numberedSeasonPostfix = new RegExp('(?:^|[^\\d])(\\d{1,2})(?!\\d)\\s+(?:season|\\u0441\\u0435\\u0437\\u043e\\u043d(?:\\u0430)?)\\s*[\\s,;:.\\-/()]+\\s*' + postfixTail, 'gi');
    while ((m = namedSeasonPostfix.exec(t)) !== null && markers.length < 50) appendPostfix(m[1], m[2], m[3]);
    while ((m = numberedSeasonPostfix.exec(t)) !== null && markers.length < 50) appendPostfix(m[1], m[2], m[3]);

    // Russian postfix season with an episode label before its number.
    // Never mistake an explicitly numbered episode for a whole-season pack.
    var russianPostfix = /(?:^|[^\d])(\d{1,2})(?!\d)\s+\u0441\u0435\u0437\u043e\u043d(?:\u0430)?\s*[,;:.\-/]?\s*\u0441\u0435\u0440\u0438(?:\u044f|\u0438|\u0439)\s*[:.]?\s*(\d{1,3})(?!\d)(?:\s*[-~]\s*(\d{1,3})(?!\d))?/gi;
    while ((m = russianPostfix.exec(t)) !== null && markers.length < 50) {
      var postStart = Number(m[2]), postEnd = m[3] ? Number(m[3]) : postStart;
      markers.push({ s: Number(m[1]), a: postStart > 0 && postEnd >= postStart && postEnd - postStart < 100 ? postStart : 0,
        b: postStart > 0 && postEnd >= postStart && postEnd - postStart < 100 ? postEnd : 0 });
    }
    // Compact Russian notation: S01 followed by an episode number and the episode word.
    var shortRussian = /(?:^|[^a-z\d])s(\d{1,2})(?!\d)\s*[,;:.\-/ ]+\s*(\d{1,3})(?!\d)(?:\s*[-~]\s*(\d{1,3})(?!\d))?\s+\u0441\u0435\u0440\u0438(?:\u044f|\u0438|\u0439)/gi;
    while ((m = shortRussian.exec(t)) !== null && markers.length < 50) {
      var shortStart = Number(m[2]), shortEnd = m[3] ? Number(m[3]) : shortStart;
      markers.push({ s: Number(m[1]), a: shortStart > 0 && shortEnd >= shortStart && shortEnd - shortStart < 100 ? shortStart : 0,
        b: shortStart > 0 && shortEnd >= shortStart && shortEnd - shortStart < 100 ? shortEnd : 0 });
    }
    // Russian form with the season noun between season and episode numbers.
    var suffixEpisodes = /(?:^|[^\d])(\d{1,2})(?!\d)\s+\u0441\u0435\u0437\u043e\u043d(?:\u0430)?\s*[,;:.\-/]?\s*(\d{1,3})(?!\d)(?:\s*[-~]\s*(\d{1,3})(?!\d))?\s+\u0441\u0435\u0440\u0438(?:\u044f|\u0438|\u0439)/gi;
    while ((m = suffixEpisodes.exec(t)) !== null && markers.length < 50) {
      var start = Number(m[2]), end = m[3] ? Number(m[3]) : start;
      markers.push({ s: Number(m[1]), a: end >= start && end - start < 100 ? start : 0,
        b: end >= start && end - start < 100 ? end : 0 });
    }
    // Russian form with the episode noun following the numbered interval.
    var prefixEpisodes = /(?:^|[^a-z\d])\u0441\u0435\u0437\u043e\u043d\s*(\d{1,2})(?!\d)\s*[:;,.\-/]?\s*(\d{1,3})(?!\d)(?:\s*[-~]\s*(\d{1,3})(?!\d))?\s+\u0441\u0435\u0440\u0438(?:\u044f|\u0438|\u0439)/gi;
    while ((m = prefixEpisodes.exec(t)) !== null && markers.length < 50) {
      var prefixStart = Number(m[2]), prefixEnd = m[3] ? Number(m[3]) : prefixStart;
      markers.push({ s: Number(m[1]), a: prefixEnd >= prefixStart && prefixEnd - prefixStart < 100 ? prefixStart : 0,
        b: prefixEnd >= prefixStart && prefixEnd - prefixStart < 100 ? prefixEnd : 0 });
    }
    return markers;
  }
  function seasonNumbers(title) {
    // Explicit season lists and ranges in release names are more reliable
    // than a guess based on the requested episode number.
    var t = clean(title, MAX_TITLE_LENGTH).replace(/[._]/g, ' ');
    var found = Object.create(null);
    function add(value) {
      var season = Number(value);
      if (Number.isInteger(season) && season >= 0 && season <= 99) found[season] = true;
    }
    function range(first, last) {
      var start = Number(first), end = Number(last);
      // A reversed or excessively wide range is not trustworthy evidence.
      if (!Number.isInteger(start) || !Number.isInteger(end) ||
          start < 0 || end > 99 || end < start || end - start > 30) return;
      for (var n = start; n <= end; n++) add(n);
    }
    function listNumbers(raw) {
      var matches = raw.match(/\d{1,2}(?!\d)/g) || [];
      for (var i = 0; i < matches.length && i < 12; i++) add(matches[i]);
    }
    var m;
    var shortSeason = /(?:^|[^a-z\d])s(\d{1,2})(?!\d|\s*e(?:p(?:isode)?)?\s*\d)(?:\s*[-~]\s*s?(\d{1,2})(?!\d|\s*e(?:p(?:isode)?)?\s*\d))?/gi;
    while ((m = shortSeason.exec(t)) !== null) {
      if (m[2] !== undefined) range(m[1], m[2]);
      else add(m[1]);
    }
    var named = /(?:\bseasons?|\u0441\u0435\u0437\u043e\u043d(?:\u044b|\u043e\u0432)?)[\s:]*([0-9]{1,2})(?!\d)(?:\s*[-~]\s*(?:s)?([0-9]{1,2})(?!\d))?((?:\s*(?:[,;&+]|\band\b|\u0438)\s*(?:s)?[0-9]{1,2}(?!\d)){0,10})/gi;
    while ((m = named.exec(t)) !== null) {
      if (m[2] !== undefined) range(m[1], m[2]);
      else add(m[1]);
      if (m[3]) listNumbers(m[3]);
    }
    // Localized suffix notation: "1-3 seasons".
    var suffix = /(?:^|\s)(\d{1,2})(?!\d)(?:\s*[-~]\s*(\d{1,2})(?!\d))?\s+(?:seasons?|\u0441\u0435\u0437\u043e\u043d)/gi;
    while ((m = suffix.exec(t)) !== null) {
      if (m[2] !== undefined) range(m[1], m[2]);
      else add(m[1]);
    }
    return Object.keys(found).map(Number);
  }
  function seasonMatches(title, season, episode, row, conf) {
    var markers = parsedEpisodes(title);
    if (markers.length) {
      // Never let another notation override an explicitly invalid interval.
      if (markers.some(function (m) { return m.a === 0 && m.b === 0; }))
        return { ok: false, pack: false };
      var matches = markers.some(function (m) { return m.s === season && episode >= m.a && episode <= m.b; });
      // An episode range or multiple distinct episode markers may represent
      // several files. Do not present its file selection as guaranteed.
      var multi = markers.some(function (m) { return m.a !== m.b; }) ||
        markers.some(function (m) { return m.s !== season || m.a !== episode || m.b !== episode; });
      return { ok: matches && (!multi || conf.allowSeasonPacks), pack: multi };
    }
    var t = clean(title, MAX_TITLE_LENGTH).replace(/[._]/g, ' ');
    var explicit = seasonNumbers(title);
    // Fail closed for unparsed numbered episode labels. Otherwise a title like
    // "Season 1 / Episode 03" can silently become an unrestricted season pack.
    var numberedEpisode = /(?:^|[^a-z])(?:episodes?|eps?|e)\s*[:.\-]?\s*\d+|(?:\u0441\u0435\u0440\u0438(?:\u044f|\u0438|\u0439)|\u044d\u043f\u0438\u0437\u043e\u0434(?:\u044b|\u0430|\u043e\u0432)?)\s*[:.\-]?\s*\d+|\d+\s*\u0441\u0435\u0440\u0438(?:\u044f|\u0438|\u0439)/i;
    if (numberedEpisode.test(t)) return { ok: false, pack: false };
    // Standalone E05 without a season is not sufficient evidence.
    if (/(?:^|[^a-z\d])e(?:pisode\s*)?\d{1,3}/i.test(t) && !explicit.length) return {ok:false,pack:false};
    var infoSeasons = row.info && Array.isArray(row.info.seasons) ? row.info.seasons.map(Number).filter(Number.isSafeInteger) : [];
    if (explicit.length) {
      return { ok: conf.allowSeasonPacks && explicit.indexOf(season) !== -1, pack: true };
    }
    if (infoSeasons.length && infoSeasons.indexOf(season) !== -1) {
      return { ok: conf.allowSeasonPacks, pack: true };
    }
    return { ok: conf.allowUnknownEpisode, pack: true };
  }
  function normalize(row, kind, year, season, episode, conf, metadata) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
    // Do not truncate an untrusted release title before interpreting episode
    // markers: an explicit episode could be hidden beyond the display cutoff.
    if (text(row.Title).length > MAX_TITLE_LENGTH) return null;
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
    var peers = peersCount(row);
    // Keep the main row short enough for a TV. The original full torrent
    // title is used above for media/episode/quality validation, not discarded.
    var technical = [tracker].concat(releaseTags(title), [sz]);
    // JacRed reports Peers, not a guaranteed leecher-only count.
    if (peers >= 0) technical.push(peers + (peers === 1 ? ' peer' : ' peers'));
    var audio = sourceAudioDetails(row);
    var display = shortReleaseLabel(title, metadata) + '\n' + technical.filter(Boolean).join(' \u00b7 ');
    if (audio) display += '\n' + audio;
    var trackers = magnetTrackers(magnet);
    return {
      url: buildMagnet(hash, trackers),
      trackers: trackers,
      infoHash: hash,
      title: display,
      name: q + ' \u00b7 ' + availability + (pack ? ' \u00b7 Multi-episode' : ''),
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
