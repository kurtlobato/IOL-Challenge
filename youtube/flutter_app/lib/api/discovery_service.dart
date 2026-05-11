import 'dart:async';
import 'package:http/http.dart' as http;
import 'package:multicast_dns/multicast_dns.dart';

class DiscoveryService {
  static const String serviceType = '_lanflix._tcp.local';

  /// Autodescubrimiento estándar vía mDNS
  Future<List<String>> discoverNodes() async {
    final MDnsClient client = MDnsClient();
    await client.start();
    final List<String> nodes = [];

    try {
      await for (final PtrResourceRecord ptr in client.lookup<PtrResourceRecord>(
        ResourceRecordQuery.serverPointer(serviceType),
      )) {
        await for (final SrvResourceRecord srv in client.lookup<SrvResourceRecord>(
          ResourceRecordQuery.service(ptr.domainName),
        )) {
          await for (final IPAddressResourceRecord ip
              in client.lookup<IPAddressResourceRecord>(
            ResourceRecordQuery.addressIPv4(srv.target),
          )) {
            final String url = 'http://${ip.address.address}:${srv.port}';
            if (!nodes.contains(url)) {
              nodes.add(url);
            }
          }
        }
      }
    } catch (_) {
      // Ignorar errores de mDNS y devolver lo encontrado
    } finally {
      client.stop();
    }
    return nodes;
  }

  /// Escaneo profundo por fuerza bruta en subredes comunes
  Stream<String> deepScanNodes() async* {
    // Intentar primero el emulador por si acaso
    yield* _checkNode('http://10.0.2.2:8080');

    // Escanear subredes comunes (192.168.1.x y 192.168.0.x)
    // Usamos lotes para no saturar la red de la TV
    for (final subnet in ['192.168.1', '192.168.0', '192.168.100', '10.0.0']) {
      final List<Future<String?>> tasks = [];
      for (int i = 1; i < 255; i++) {
        tasks.add(_testIp('http://$subnet.$i:8080'));
        
        // Procesar en ráfagas de 20 para no bloquear la CPU de la TV
        if (tasks.length >= 20) {
          final results = await Future.wait(tasks);
          for (final r in results) {
            if (r != null) yield r;
          }
          tasks.clear();
        }
      }
      // Procesar el resto de la subred
      final results = await Future.wait(tasks);
      for (final r in results) {
        if (r != null) yield r;
      }
    }
  }

  Stream<String> _checkNode(String url) async* {
    final res = await _testIp(url);
    if (res != null) yield res;
  }

  Future<String?> _testIp(String url) async {
    try {
      final response = await http.get(Uri.parse('$url/api/health')).timeout(
        const Duration(milliseconds: 500),
      );
      if (response.statusCode == 200) {
        return url;
      }
    } catch (_) {}
    return null;
  }
}
