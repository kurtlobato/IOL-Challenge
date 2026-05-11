import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../models/series_item.dart';
import '../models/video_item.dart';
import '../providers/app_providers.dart';
import '../widgets/poster_card.dart';
import 'player_screen.dart';
import 'series_videos_screen.dart';
import 'settings_screen.dart';
import 'video_detail_screen.dart';

bool useTvHomeLayout(BuildContext context) {
  // Ajustamos el umbral para que emuladores de 720p (que pueden tener densidades altas)
  // activen el modo TV correctamente.
  return MediaQuery.sizeOf(context).shortestSide >= 300;
}

class HomeScreen extends ConsumerWidget {
  const HomeScreen({super.key});

  void _openVideo(BuildContext context, VideoItem v) {
    Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (context) => PlayerScreen(video: v),
        fullscreenDialog: true,
      ),
    );
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final settings = ref.watch(settingsNotifierProvider);
    final seriesAsync = ref.watch(seriesProvider);
    final videosAsync = ref.watch(videosProvider);
    final tv = useTvHomeLayout(context);

    return Scaffold(
      appBar: AppBar(
        title: const Text('Lanflix'),
        actions: [
          if (settings.apiBase.isEmpty)
            const Padding(
              padding: EdgeInsets.only(right: 8),
              child: Icon(Icons.warning_amber_rounded),
            ),
          IconButton(
            icon: const Icon(Icons.refresh),
            onPressed: settings.apiBase.isEmpty
                ? null
                : () {
                    ref.invalidate(seriesProvider);
                    ref.invalidate(videosProvider);
                  },
          ),
          IconButton(
            icon: const Icon(Icons.settings),
            onPressed: () {
              Navigator.of(context).push(
                MaterialPageRoute<void>(
                  builder: (context) => const SettingsScreen(),
                ),
              );
            },
          ),
        ],
      ),
      body: settings.apiBase.isEmpty
          ? const Center(
              child: Padding(
                padding: EdgeInsets.all(24),
                child: Text(
                  'Configura la URL del nodo en Ajustes (icono engranaje).',
                  textAlign: TextAlign.center,
                ),
              ),
            )
          : tv
              ? _TvHome(
                  seriesAsync: seriesAsync,
                  videosAsync: videosAsync,
                  onOpenVideo: (v) => _openVideo(context, v),
                )
              : _PhoneHome(
                  seriesAsync: seriesAsync,
                  videosAsync: videosAsync,
                  onOpenVideo: (v) => _openVideo(context, v),
                ),
    );
  }
}

class _TvHome extends StatelessWidget {
  const _TvHome({
    required this.seriesAsync,
    required this.videosAsync,
    required this.onOpenVideo,
  });

  final AsyncValue<List<SeriesItem>> seriesAsync;
  final AsyncValue<List<VideoItem>> videosAsync;
  final void Function(VideoItem) onOpenVideo;

  @override
  Widget build(BuildContext context) {
    return seriesAsync.when(
      data: (series) => videosAsync.when(
        data: (videos) {
          // Filtrar vídeos: solo los que NO tienen serie
          final standaloneVideos = videos.where((v) => v.series == null).toList();

          if (series.isEmpty && standaloneVideos.isEmpty) {
            return const Center(child: Text('Biblioteca vacía'));
          }

          return CustomScrollView(
            slivers: [
              const SliverToBoxAdapter(
                child: Padding(
                  padding: EdgeInsets.fromLTRB(16, 16, 16, 8),
                  child: Text(
                    'Tu Biblioteca',
                    style: TextStyle(fontSize: 24, fontWeight: FontWeight.bold),
                  ),
                ),
              ),
              SliverPadding(
                padding: const EdgeInsets.all(16),
                sliver: SliverGrid(
                  gridDelegate: const SliverGridDelegateWithMaxCrossAxisExtent(
                    maxCrossAxisExtent: 300,
                    mainAxisSpacing: 24,
                    crossAxisSpacing: 16,
                    mainAxisExtent: 280, // Aumentado para evitar overflow
                  ),
                  delegate: SliverChildBuilderDelegate(
                    (context, index) {
                      // Primero las series, luego los vídeos
                      if (index < series.length) {
                        final s = series[index];
                        return PosterCard(
                          title: s.title,
                          subtitle: s.genre,
                          imageUrl: s.thumbnailUrl,
                          badge: s.episodeCount != null
                              ? '${s.episodeCount} capítulos'
                              : null,
                          onTap: () {
                            Navigator.of(context).push(
                              MaterialPageRoute<void>(
                                builder: (context) =>
                                    SeriesVideosScreen(series: s),
                              ),
                            );
                          },
                        );
                      } else {
                        final v = standaloneVideos[index - series.length];
                        final meta = [
                          v.nodeName ?? '',
                          '${v.viewCount} vistas',
                        ].where((e) => e.isNotEmpty).join(' • ');

                        return PosterCard(
                          title: v.title,
                          subtitle: v.series?.title,
                          imageUrl: v.thumbnailUrl,
                          videoUrl: v.playbackUri,
                          metadata: meta,
                          onTap: () => onOpenVideo(v),
                        );
                      }
                    },
                    childCount: series.length + standaloneVideos.length,
                  ),
                ),
              ),
            ],
          );
        },
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (e, _) => Center(child: Text('$e')),
      ),
      loading: () => const Center(child: CircularProgressIndicator()),
      error: (e, _) => Center(child: Text('$e')),
    );
  }
}

class _PhoneHome extends StatelessWidget {
  const _PhoneHome({
    required this.seriesAsync,
    required this.videosAsync,
    required this.onOpenVideo,
  });

  final AsyncValue<List<SeriesItem>> seriesAsync;
  final AsyncValue<List<VideoItem>> videosAsync;
  final void Function(VideoItem) onOpenVideo;

  @override
  Widget build(BuildContext context) {
    return seriesAsync.when(
      data: (series) => videosAsync.when(
        data: (videos) {
          final standaloneVideos = videos.where((v) => v.series == null).toList();

          if (series.isEmpty && standaloneVideos.isEmpty) {
            return const Center(child: Text('Biblioteca vacía'));
          }

          return ListView(
            padding: const EdgeInsets.only(bottom: 24),
            children: [
              if (series.isNotEmpty) ...[
                const ListTile(
                  title: Text('Series', style: TextStyle(fontWeight: FontWeight.bold)),
                ),
                ...series.map<Widget>(
                  (s) => ListTile(
                    leading: const Icon(Icons.folder_outlined),
                    title: Text(s.title),
                    subtitle: Text(s.genre ?? ''),
                    onTap: () {
                      Navigator.of(context).push(
                        MaterialPageRoute<void>(
                          builder: (context) => SeriesVideosScreen(series: s),
                        ),
                      );
                    },
                  ),
                ),
                const Divider(),
              ],
              if (standaloneVideos.isNotEmpty) ...[
                const ListTile(
                  title: Text('Vídeos sueltos', style: TextStyle(fontWeight: FontWeight.bold)),
                ),
                ...standaloneVideos.map<Widget>(
                  (v) => ListTile(
                    leading: v.thumbnailUrl != null && v.thumbnailUrl!.isNotEmpty
                        ? Image.network(
                            v.thumbnailUrl!,
                            width: 56,
                            height: 56,
                            fit: BoxFit.cover,
                            errorBuilder: (_, __, ___) => const Icon(Icons.movie),
                          )
                        : const Icon(Icons.movie),
                    title: Text(v.title),
                    subtitle: Text(v.nodeName ?? v.status),
                    onTap: () => onOpenVideo(v),
                  ),
                ),
              ],
            ],
          );
        },
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (e, _) => Center(child: Text('$e')),
      ),
      loading: () => const Center(child: CircularProgressIndicator()),
      error: (e, _) => Center(child: Text('$e')),
    );
  }
}
