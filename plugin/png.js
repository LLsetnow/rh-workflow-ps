// =========================================================================
// 自包含 PNG 编码器 (无损, 支持 RGBA=color type 6 与 灰度=color type 0)
// UXP 的 imaging.encodeImageData 只输出 JPEG(有损、无 alpha)，Canvas 也不支持
// putImageData/toDataURL，因此插件侧裁切后必须用纯 JS 编码 PNG。
// DEFLATE 采用固定 Huffman + 贪心 LZ77，已在 Node(zlib) 与 macOS(sips) 双解码器
// 上做过逐字节校验(尺寸/CRC/像素往返/压缩率)。
// =========================================================================
var _PNG_CRC_TABLE = (function () {
  var table = new Array(256);
  for (var n = 0; n < 256; n++) {
    var c = n;
    for (var k = 0; k < 8; k++) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function _pngCrc32(bytes, start, end) {
  var crc = 0xffffffff;
  for (var i = start; i < end; i++) {
    crc = _PNG_CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function _pngAdler32(bytes) {
  var a = 1, b = 0;
  var MOD = 65521;
  var i = 0;
  var len = bytes.length;
  while (i < len) {
    var tlen = len - i > 5552 ? 5552 : len - i;
    for (var n = 0; n < tlen; n++) {
      a += bytes[i++];
      b += a;
    }
    a %= MOD;
    b %= MOD;
  }
  return ((b << 16) | a) >>> 0;
}

function _PngBitWriter() {
  this.bytes = [];
  this.bitBuffer = 0;
  this.bitCount = 0;
}
_PngBitWriter.prototype.writeBits = function (value, nbits) {
  this.bitBuffer |= (value << this.bitCount);
  this.bitCount += nbits;
  while (this.bitCount >= 8) {
    this.bytes.push(this.bitBuffer & 0xff);
    this.bitBuffer >>>= 8;
    this.bitCount -= 8;
  }
};
_PngBitWriter.prototype.writeHuff = function (code, nbits) {
  // Huffman codes are defined MSB-first; reverse them for the LSB-first writer.
  var reversed = 0;
  for (var i = 0; i < nbits; i++) {
    reversed = (reversed << 1) | ((code >>> i) & 1);
  }
  this.writeBits(reversed, nbits);
};
_PngBitWriter.prototype.finish = function () {
  if (this.bitCount > 0) {
    this.bytes.push(this.bitBuffer & 0xff);
    this.bitBuffer = 0;
    this.bitCount = 0;
  }
  return this.bytes;
};

function _pngWriteFixedLiteral(bw, litval) {
  if (litval <= 143) bw.writeHuff(0x30 + litval, 8);
  else bw.writeHuff(0x190 + (litval - 144), 9);
}

var _PNG_LEN_BASE = [3,4,5,6,7,8,9,10,11,13,15,17,19,23,27,31,35,43,51,59,67,83,99,115,131,163,195,227,258];
var _PNG_LEN_EXTRA = [0,0,0,0,0,0,0,0,1,1,1,1,2,2,2,2,3,3,3,3,4,4,4,4,5,5,5,5,0];
function _pngWriteFixedLength(bw, length) {
  var idx = 0;
  for (var i = 28; i >= 0; i--) {
    if (length >= _PNG_LEN_BASE[i]) { idx = i; break; }
  }
  var sym = 257 + idx;
  if (sym <= 279) bw.writeHuff(0x00 + (sym - 256), 7);
  else bw.writeHuff(0xc0 + (sym - 280), 8);
  var eb = _PNG_LEN_EXTRA[idx];
  if (eb > 0) bw.writeBits(length - _PNG_LEN_BASE[idx], eb);
}

var _PNG_DIST_BASE = [1,2,3,4,5,7,9,13,17,25,33,49,65,97,129,193,257,385,513,769,1025,1537,2049,3073,4097,6145,8193,12289,16385,24577];
var _PNG_DIST_EXTRA = [0,0,0,0,1,1,2,2,3,3,4,4,5,5,6,6,7,7,8,8,9,9,10,10,11,11,12,12,13,13];
function _pngWriteFixedDistance(bw, dist) {
  var idx = 0;
  for (var i = 29; i >= 0; i--) {
    if (dist >= _PNG_DIST_BASE[i]) { idx = i; break; }
  }
  bw.writeHuff(idx, 5);
  var eb = _PNG_DIST_EXTRA[idx];
  if (eb > 0) bw.writeBits(dist - _PNG_DIST_BASE[idx], eb);
}

function _pngDeflateFixed(data) {
  var len = data.length;
  var bw = new _PngBitWriter();
  bw.writeBits(1, 1); // BFINAL=1
  bw.writeBits(1, 2); // BTYPE=01 (fixed Huffman)

  var WSIZE = 32768;
  var MIN_MATCH = 3;
  var MAX_MATCH = 258;
  var HASH_SIZE = 1 << 15;
  var HASH_MASK = HASH_SIZE - 1;
  var head = new Int32Array(HASH_SIZE);
  var prev = new Int32Array(len > 0 ? len : 1);
  for (var hi = 0; hi < HASH_SIZE; hi++) head[hi] = -1;

  var MAX_CHAIN = 128;
  var pos = 0;
  while (pos < len) {
    var bestLen = 0;
    var bestDist = 0;
    if (pos + MIN_MATCH <= len) {
      var hv = ((data[pos] << 10) ^ (data[pos + 1] << 5) ^ data[pos + 2]) & HASH_MASK;
      var cand = head[hv];
      var chain = 0;
      var limit = len - pos;
      if (limit > MAX_MATCH) limit = MAX_MATCH;
      while (cand >= 0 && chain < MAX_CHAIN) {
        var dist = pos - cand;
        if (dist > WSIZE) break;
        if (bestLen === 0 || data[cand + bestLen] === data[pos + bestLen]) {
          var l = 0;
          while (l < limit && data[cand + l] === data[pos + l]) l++;
          if (l > bestLen) {
            bestLen = l;
            bestDist = dist;
            if (l >= limit) break;
          }
        }
        cand = prev[cand];
        chain++;
      }
    }

    if (bestLen >= MIN_MATCH) {
      _pngWriteFixedLength(bw, bestLen);
      _pngWriteFixedDistance(bw, bestDist);
      var end = pos + bestLen;
      while (pos < end) {
        if (pos + MIN_MATCH <= len) {
          var hh = ((data[pos] << 10) ^ (data[pos + 1] << 5) ^ data[pos + 2]) & HASH_MASK;
          prev[pos] = head[hh];
          head[hh] = pos;
        }
        pos++;
      }
    } else {
      _pngWriteFixedLiteral(bw, data[pos]);
      if (pos + MIN_MATCH <= len) {
        var hx = ((data[pos] << 10) ^ (data[pos + 1] << 5) ^ data[pos + 2]) & HASH_MASK;
        prev[pos] = head[hx];
        head[hx] = pos;
      }
      pos++;
    }
  }

  bw.writeHuff(0x00, 7); // end-of-block symbol 256
  return bw.finish();
}

function _pngZlibCompress(data) {
  var deflated = _pngDeflateFixed(data);
  var adler = _pngAdler32(data);
  var out = [];
  out.push(0x78); // CMF
  out.push(0x01); // FLG (level 0, no dict, valid FCHECK)
  for (var i = 0; i < deflated.length; i++) out.push(deflated[i]);
  out.push((adler >>> 24) & 0xff, (adler >>> 16) & 0xff, (adler >>> 8) & 0xff, adler & 0xff);
  return out;
}

function _pngPaeth(a, b, c) {
  var p = a + b - c;
  var pa = p > a ? p - a : a - p;
  var pb = p > b ? p - b : b - p;
  var pc = p > c ? p - c : c - p;
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

function _pngFilterScanlines(pixels, width, height, channels) {
  var stride = width * channels;
  var out = new Uint8Array((stride + 1) * height);
  var prevRow = new Uint8Array(stride);
  var curFiltered = new Uint8Array(stride);
  var bestFiltered = new Uint8Array(stride);
  var op = 0;
  for (var y = 0; y < height; y++) {
    var rowStart = y * stride;
    var bestType = 0;
    var bestSum = -1;
    for (var ft = 0; ft < 5; ft++) {
      var sum = 0;
      for (var x = 0; x < stride; x++) {
        var raw = pixels[rowStart + x];
        var left = x >= channels ? pixels[rowStart + x - channels] : 0;
        var up = prevRow[x];
        var ul = x >= channels ? prevRow[x - channels] : 0;
        var val;
        if (ft === 0) val = raw;
        else if (ft === 1) val = (raw - left) & 0xff;
        else if (ft === 2) val = (raw - up) & 0xff;
        else if (ft === 3) val = (raw - ((left + up) >> 1)) & 0xff;
        else val = (raw - _pngPaeth(left, up, ul)) & 0xff;
        curFiltered[x] = val;
        sum += val < 128 ? val : 256 - val;
      }
      if (bestSum < 0 || sum < bestSum) {
        bestSum = sum;
        bestType = ft;
        var tmp = bestFiltered; bestFiltered = curFiltered; curFiltered = tmp;
      }
    }
    out[op++] = bestType;
    for (var xx = 0; xx < stride; xx++) out[op++] = bestFiltered[xx];
    for (var xr = 0; xr < stride; xr++) prevRow[xr] = pixels[rowStart + xr];
  }
  return out;
}

function _pngU32be(arr, v) {
  arr.push((v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff);
}

function _pngChunk(out, type, data) {
  _pngU32be(out, data.length);
  var typeStart = out.length;
  out.push(type.charCodeAt(0), type.charCodeAt(1), type.charCodeAt(2), type.charCodeAt(3));
  for (var i = 0; i < data.length; i++) out.push(data[i]);
  var crc = _pngCrc32(out, typeStart, out.length);
  _pngU32be(out, crc);
}

// pixels: Uint8Array chunky. channels: 4 表示 RGBA(type 6), 1 表示灰度(type 0)。
function _encodePng(pixels, width, height, channels) {
  var colorType = channels === 1 ? 0 : 6;
  var filtered = _pngFilterScanlines(pixels, width, height, channels);
  var idat = _pngZlibCompress(filtered);
  var out = [];
  out.push(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
  var ihdr = [];
  _pngU32be(ihdr, width);
  _pngU32be(ihdr, height);
  ihdr.push(8, colorType, 0, 0, 0);
  _pngChunk(out, "IHDR", ihdr);
  _pngChunk(out, "IDAT", idat);
  _pngChunk(out, "IEND", []);
  return new Uint8Array(out);
}
