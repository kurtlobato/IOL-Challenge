import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:http/http.dart' as http;

import '../api/lanflix_api.dart';
import '../models/series_item.dart';
import '../models/video_item.dart';
import '../settings/settings_repository.dart';

/// Sobrescribir en `main` tras cargar [SharedPreferences].
final settingsRepositoryProvider = Provider<SettingsRepository>(
  (ref) => throw UnimplementedError('Override settingsRepositoryProvider'),
);

final httpClientProvider = Provider<http.Client>((ref) {
  final c = http.Client();
  ref.onDispose(c.close);
  return c;
});

class SettingsState {
  const SettingsState({required this.apiBase, required this.federated});

  final String apiBase;
  final bool federated;
}

class SettingsNotifier extends Notifier<SettingsState> {
  @override
  SettingsState build() {
    final r = ref.read(settingsRepositoryProvider);
    return SettingsState(apiBase: r.apiBase, federated: r.federated);
  }

  Future<void> setApiBase(String url) async {
    await ref.read(settingsRepositoryProvider).setApiBase(url);
    _reload();
  }

  Future<void> setFederated(bool value) async {
    await ref.read(settingsRepositoryProvider).setFederated(value);
    _reload();
  }

  void _reload() {
    final r = ref.read(settingsRepositoryProvider);
    state = SettingsState(apiBase: r.apiBase, federated: r.federated);
  }
}

final settingsNotifierProvider =
    NotifierProvider<SettingsNotifier, SettingsState>(SettingsNotifier.new);

final lanflixApiProvider = Provider<LanflixApi?>((ref) {
  final base = ref.watch(settingsNotifierProvider).apiBase;
  if (base.isEmpty) return null;
  return LanflixApi(
    client: ref.watch(httpClientProvider),
    baseUrl: base,
  );
});

final videosProvider =
    FutureProvider.autoDispose<List<VideoItem>>((ref) async {
  final api = ref.watch(lanflixApiProvider);
  final federated = ref.watch(settingsNotifierProvider).federated;
  if (api == null) return [];
  return api.listVideos(federated: federated);
});

final seriesProvider =
    FutureProvider.autoDispose<List<SeriesItem>>((ref) async {
  final api = ref.watch(lanflixApiProvider);
  if (api == null) return [];
  return api.listSeries();
});

final viewerKeyProvider = FutureProvider<String>((ref) {
  return ref.read(settingsRepositoryProvider).getOrCreateViewerKey();
});
