class SeriesItem {
  const SeriesItem({
    required this.id,
    required this.nodeId,
    required this.title,
    this.description,
    this.genre,
    this.year,
    this.thumbnailUrl,
    this.episodeCount,
  });

  final String id;
  final String nodeId;
  final String title;
  final String? description;
  final String? genre;
  final int? year;
  final String? thumbnailUrl;
  final int? episodeCount;

  factory SeriesItem.fromJson(Map<String, dynamic> json) {
    return SeriesItem(
      id: json['id'] as String,
      nodeId: json['nodeId'] as String,
      title: json['title'] as String? ?? '',
      description: json['description'] as String?,
      genre: json['genre'] as String?,
      year: (json['year'] as num?)?.toInt(),
      thumbnailUrl: json['thumbnailUrl'] as String?,
      episodeCount: (json['episodeCount'] as num?)?.toInt(),
    );
  }
}
