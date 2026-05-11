import 'dart:convert';

import 'package:http/http.dart' as http;

import '../models/series_item.dart';
import '../models/video_item.dart';

/// Construye el prefijo `/api` a partir de la base del nodo (sin barra final).
String apiPrefixForBase(String base) {
  final b = base.trim().replaceAll(RegExp(r'/$'), '');
  if (b.isEmpty) return '';
  return '$b/api';
}

class LanflixApi {
  LanflixApi({
    required http.Client client,
    required String baseUrl,
  })  : _client = client,
        _base = baseUrl.trim().replaceAll(RegExp(r'/$'), '');

  final http.Client _client;
  final String _base;

  String get _prefix => apiPrefixForBase(_base);

  Future<List<VideoItem>> listVideos({bool federated = false}) async {
    final q = federated ? '?federated=true' : '';
    final uri = Uri.parse('$_prefix/videos$q');
    final res = await _client.get(uri);
    final List<dynamic> raw = await _parseJsonList(res);
    return raw.map<VideoItem>((e) => normalizeVideo(e as Map<String, dynamic>)).toList();
  }

  Future<List<SeriesItem>> listSeries() async {
    final uri = Uri.parse('$_prefix/series');
    final res = await _client.get(uri);
    final List<dynamic> raw = await _parseJsonList(res);
    return raw
        .map<SeriesItem>((e) => SeriesItem.fromJson(e as Map<String, dynamic>))
        .toList();
  }

  Future<VideoItem> getVideo(String id) async {
    final enc = Uri.encodeComponent(id);
    final uri = Uri.parse('$_prefix/videos/$enc');
    final res = await _client.get(uri);
    final map = await _parseJsonMap(res);
    return normalizeVideo(map);
  }

  /// Igual que la web: cuenta vistas contra el origen del [streamUrl] si aplica.
  String _viewsApiBase(VideoItem video) {
    try {
      if (video.streamUrl.isNotEmpty) {
        return Uri.parse(video.streamUrl).origin;
      }
    } catch (_) {}
    return _base;
  }

  /// Devuelve el nuevo [viewCount].
  Future<int> recordViewForVideo(
    VideoItem video,
    String viewerKey,
    int watchedSeconds,
  ) async {
    final base = _viewsApiBase(video);
    final prefix = apiPrefixForBase(base);
    final enc = Uri.encodeComponent(video.id);
    final uri = Uri.parse('$prefix/videos/$enc/views');
    final res = await _client.post(
      uri,
      headers: {'Content-Type': 'application/json'},
      body: jsonEncode({
        'viewerKey': viewerKey,
        'watchedSeconds': watchedSeconds,
      }),
    );
    final map = await _parseJsonMap(res);
    return (map['viewCount'] as num?)?.toInt() ?? 0;
  }

  Future<dynamic> _parseJsonList(http.Response res) async {
    if (!res.statusCode.toString().startsWith('2')) {
      throw _apiError(res);
    }
    final decoded = jsonDecode(res.body);
    if (decoded is! List) {
      throw const FormatException('Respuesta JSON no es lista');
    }
    return decoded;
  }

  Future<Map<String, dynamic>> _parseJsonMap(http.Response res) async {
    if (!res.statusCode.toString().startsWith('2')) {
      throw _apiError(res);
    }
    final decoded = jsonDecode(res.body);
    if (decoded is! Map<String, dynamic>) {
      throw const FormatException('Respuesta JSON no es objeto');
    }
    return decoded;
  }

  Exception _apiError(http.Response res) {
    try {
      final m = jsonDecode(res.body);
      if (m is Map && m['error'] is String) {
        return Exception(m['error'] as String);
      }
    } catch (_) {}
    return Exception(res.reasonPhrase ?? 'HTTP ${res.statusCode}');
  }
}
