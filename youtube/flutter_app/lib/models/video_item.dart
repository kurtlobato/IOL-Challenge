class SeriesRef {
  const SeriesRef({
    required this.id,
    required this.nodeId,
    required this.title,
    this.description,
    this.genre,
    this.year,
    this.thumbnailUrl,
  });

  final String id;
  final String nodeId;
  final String title;
  final String? description;
  final String? genre;
  final int? year;
  final String? thumbnailUrl;

  factory SeriesRef.fromJson(Map<String, dynamic> json) {
    return SeriesRef(
      id: json['id'] as String,
      nodeId: json['nodeId'] as String,
      title: json['title'] as String? ?? '',
      description: json['description'] as String?,
      genre: json['genre'] as String?,
      year: (json['year'] as num?)?.toInt(),
      thumbnailUrl: json['thumbnailUrl'] as String?,
    );
  }
}

class SubtitleItem {
  const SubtitleItem({
    required this.id,
    required this.label,
    required this.url,
  });

  final int id;
  final String label;
  final String url;

  factory SubtitleItem.fromJson(Map<String, dynamic> json) {
    return SubtitleItem(
      id: (json['id'] as num).toInt(),
      label: json['label'] as String? ?? 'Subtítulo',
      url: json['url'] as String? ?? '',
    );
  }
}

class VideoItem {
  const VideoItem({
    required this.id,
    required this.nodeId,
    this.nodeName,
    required this.title,
    this.description,
    this.genre,
    this.year,
    this.season,
    this.episode,
    this.series,
    required this.status,
    required this.streamUrl,
    this.manifestUrl,
    this.thumbnailUrl,
    this.errorMessage,
    this.uploaderId,
    required this.createdAt,
    this.progressPercent,
    this.durationSeconds,
    required this.viewCount,
    this.source,
    this.compat,
    this.transcode,
    this.subtitles = const [],
  });

  final String id;
  final String nodeId;
  final String? nodeName;
  final String title;
  final String? description;
  final String? genre;
  final int? year;
  final int? season;
  final int? episode;
  final SeriesRef? series;
  final String status;
  final String streamUrl;
  final String? manifestUrl;
  final String? thumbnailUrl;
  final String? errorMessage;
  final String? uploaderId;
  final String createdAt;
  final double? progressPercent;
  final int? durationSeconds;
  final int viewCount;
  final Map<String, dynamic>? source;
  final Map<String, dynamic>? compat;
  final Map<String, dynamic>? transcode;
  final List<SubtitleItem> subtitles;

  factory VideoItem.fromJson(Map<String, dynamic> json) {
    final seriesRaw = json['series'];
    final subsRaw = json['subtitles'] as List?;
    
    return VideoItem(
      id: json['id'] as String,
      nodeId: json['nodeId'] as String,
      nodeName: json['nodeName'] as String?,
      title: json['title'] as String? ?? '',
      description: json['description'] as String?,
      genre: json['genre'] as String?,
      year: (json['year'] as num?)?.toInt(),
      season: (json['season'] as num?)?.toInt(),
      episode: (json['episode'] as num?)?.toInt(),
      series: seriesRaw is Map<String, dynamic>
          ? SeriesRef.fromJson(seriesRaw)
          : null,
      status: json['status'] as String? ?? '',
      streamUrl: json['streamUrl'] as String? ?? '',
      manifestUrl: json['manifestUrl'] as String?,
      thumbnailUrl: json['thumbnailUrl'] as String?,
      errorMessage: json['errorMessage'] as String?,
      uploaderId: json['uploaderId'] as String?,
      createdAt: json['createdAt'] as String? ?? '',
      progressPercent: (json['progressPercent'] as num?)?.toDouble(),
      durationSeconds: (json['durationSeconds'] as num?)?.toInt(),
      viewCount: (json['viewCount'] as num?)?.toInt() ?? 0,
      source: json['source'] as Map<String, dynamic>?,
      compat: json['compat'] as Map<String, dynamic>?,
      transcode: json['transcode'] as Map<String, dynamic>?,
      subtitles: subsRaw != null
          ? subsRaw.map((s) => SubtitleItem.fromJson(s as Map<String, dynamic>)).toList()
          : const [],
    );
  }

  /// URL para el reproductor: HLS si hay manifest, si no stream directo.
  String? get playbackUri {
    final m = manifestUrl;
    if (m != null && m.isNotEmpty) return m;
    if (streamUrl.isNotEmpty) return streamUrl;
    return null;
  }
}

VideoItem normalizeVideo(Map<String, dynamic> json) =>
    VideoItem.fromJson(json);
