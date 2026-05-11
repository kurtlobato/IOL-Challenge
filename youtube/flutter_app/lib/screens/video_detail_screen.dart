import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../models/video_item.dart';
import '../providers/app_providers.dart';
import 'player_screen.dart';

final videoDetailProvider =
    FutureProvider.family<VideoItem, String>((ref, id) async {
  final api = ref.watch(lanflixApiProvider);
  if (api == null) {
    throw StateError('Configura la URL del nodo en Ajustes');
  }
  return api.getVideo(id);
});

class VideoDetailScreen extends ConsumerWidget {
  const VideoDetailScreen({
    super.key,
    required this.videoId,
    this.initial,
  });

  final String videoId;
  final VideoItem? initial;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final asyncVideo = ref.watch(videoDetailProvider(videoId));

    return asyncVideo.when(
      data: (v) => _DetailBody(video: v),
      loading: () {
        if (initial != null) {
          return _DetailBody(video: initial!);
        }
        return const Scaffold(
          body: Center(child: CircularProgressIndicator()),
        );
      },
      error: (e, _) => Scaffold(
        appBar: AppBar(title: const Text('Error')),
        body: Center(child: Text('$e')),
      ),
    );
  }
}

class _DetailBody extends StatelessWidget {
  const _DetailBody({required this.video});

  final VideoItem video;

  @override
  Widget build(BuildContext context) {
    final canPlay = video.playbackUri != null;
    return Scaffold(
      appBar: AppBar(title: Text(video.title)),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          if (video.thumbnailUrl != null && video.thumbnailUrl!.isNotEmpty)
            ClipRRect(
              borderRadius: BorderRadius.circular(8),
              child: AspectRatio(
                aspectRatio: 16 / 9,
                child: Image.network(
                  video.thumbnailUrl!,
                  fit: BoxFit.cover,
                  errorBuilder: (_, __, ___) => const SizedBox.shrink(),
                ),
              ),
            ),
          const SizedBox(height: 16),
          Text(video.description ?? '', style: Theme.of(context).textTheme.bodyLarge),
          const SizedBox(height: 8),
          Text('Estado: ${video.status}'),
          if (video.series != null)
            Text('Serie: ${video.series!.title}'),
          if (video.season != null || video.episode != null)
            Text('T${video.season ?? "?"} E${video.episode ?? "?"}'),
          Text('Vistas: ${video.viewCount}'),
          const SizedBox(height: 24),
          FilledButton.icon(
            onPressed: canPlay
                ? () {
                    Navigator.of(context).push(
                      MaterialPageRoute<void>(
                        builder: (context) => PlayerScreen(video: video),
                        fullscreenDialog: true,
                      ),
                    );
                  }
                : null,
            icon: const Icon(Icons.play_arrow),
            label: const Text('Reproducir'),
          ),
        ],
      ),
    );
  }
}
