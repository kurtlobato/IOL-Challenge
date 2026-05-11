import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../models/series_item.dart';
import '../providers/app_providers.dart';
import '../widgets/poster_card.dart';
import 'player_screen.dart';

class SeriesVideosScreen extends ConsumerWidget {
  const SeriesVideosScreen({super.key, required this.series});

  final SeriesItem series;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final videosAsync = ref.watch(videosProvider);

    return Scaffold(
      appBar: AppBar(title: Text(series.title)),
      body: videosAsync.when(
        data: (all) {
          final episodes = all
              .where(
                (v) =>
                    v.series?.id == series.id &&
                    v.series?.nodeId == series.nodeId,
              )
              .toList()
            ..sort((a, b) {
              final sa = a.season ?? 0;
              final sb = b.season ?? 0;
              if (sa != sb) return sa.compareTo(sb);
              return (a.episode ?? 0).compareTo(b.episode ?? 0);
            });

          if (episodes.isEmpty) {
            return const Center(
              child: Text('Sin capítulos en este nodo'),
            );
          }

          return GridView.builder(
            padding: const EdgeInsets.all(16),
            gridDelegate: const SliverGridDelegateWithMaxCrossAxisExtent(
              maxCrossAxisExtent: 300,
              mainAxisSpacing: 24,
              crossAxisSpacing: 16,
              mainAxisExtent: 280,
            ),
            itemCount: episodes.length,
            itemBuilder: (context, i) {
              final v = episodes[i];
              final meta = [
                v.nodeName ?? '',
                '${v.viewCount} vistas',
              ].where((e) => e.isNotEmpty).join(' • ');

              return PosterCard(
                title: v.title,
                subtitle: 'T${v.season ?? "?"} E${v.episode ?? "?"}',
                imageUrl: v.thumbnailUrl,
                videoUrl: v.playbackUri,
                metadata: meta,
                onTap: () {
                  Navigator.of(context).push(
                    MaterialPageRoute<void>(
                      builder: (context) => PlayerScreen(video: v),
                      fullscreenDialog: true,
                    ),
                  );
                },
              );
            },
          );
        },
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (e, _) => Center(child: Text('$e')),
      ),
    );
  }
}
