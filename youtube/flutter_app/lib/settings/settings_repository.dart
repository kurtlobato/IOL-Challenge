import 'dart:math';

import 'package:shared_preferences/shared_preferences.dart';

const _kApiBase = 'lanflix_api_base';
const _kFederated = 'lanflix_federated';
const _kViewerKey = 'lanflix_viewer_key';

class SettingsRepository {
  SettingsRepository(this._prefs);

  final SharedPreferences _prefs;

  String get apiBase => (_prefs.getString(_kApiBase) ?? '').trim();

  Future<void> setApiBase(String url) async {
    final t = url.trim().replaceAll(RegExp(r'/$'), '');
    if (t.isEmpty) {
      await _prefs.remove(_kApiBase);
    } else {
      await _prefs.setString(_kApiBase, t);
    }
  }

  bool get federated => _prefs.getBool(_kFederated) ?? true;

  Future<void> setFederated(bool value) => _prefs.setBool(_kFederated, value);

  /// Clave estable por dispositivo (equivalente a la web).
  Future<String> getOrCreateViewerKey() async {
    var k = _prefs.getString(_kViewerKey);
    if (k == null || k.isEmpty) {
      final r = Random();
      k = 'user_${r.nextInt(1 << 30)}';
      await _prefs.setString(_kViewerKey, k);
    }
    return k;
  }
}
