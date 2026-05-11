import 'package:flutter_test/flutter_test.dart';
import 'package:lanflix_tv/api/lanflix_api.dart';
import 'package:lanflix_tv/models/video_item.dart';

void main() {
  test('apiPrefixForBase sin barra final', () {
    expect(
      apiPrefixForBase('http://192.168.1.10:8080'),
      'http://192.168.1.10:8080/api',
    );
  });

  test('apiPrefixForBase recorta barra final', () {
    expect(
      apiPrefixForBase('http://peer:8080/'),
      'http://peer:8080/api',
    );
  });

  test('VideoItem.playbackUri prioriza manifestUrl', () {
    final v = VideoItem.fromJson({
      'id': 'a',
      'nodeId': 'n',
      'title': 't',
      'status': 'ready',
      'streamUrl': 'http://x/mp4',
      'manifestUrl': 'http://x/hls.m3u8',
      'createdAt': '',
      'viewCount': 0,
    });
    expect(v.playbackUri, 'http://x/hls.m3u8');
  });

  test('VideoItem.playbackUri usa streamUrl si no hay manifest', () {
    final v = VideoItem.fromJson({
      'id': 'a',
      'nodeId': 'n',
      'title': 't',
      'status': 'ready',
      'streamUrl': 'http://x/v.mp4',
      'manifestUrl': null,
      'createdAt': '',
      'viewCount': 0,
    });
    expect(v.playbackUri, 'http://x/v.mp4');
  });

  test('normalizeVideo rellena viewCount por defecto', () {
    final v = normalizeVideo({
      'id': 'a',
      'nodeId': 'n',
      'title': 't',
      'status': 'ready',
      'streamUrl': '',
      'createdAt': '',
    });
    expect(v.viewCount, 0);
  });
}
