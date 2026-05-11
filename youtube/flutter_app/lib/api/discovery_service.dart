import 'package:multicast_dns/multicast_dns.dart';

class DiscoveryService {
  static const String serviceType = '_lanflix._tcp.local';

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
    } finally {
      client.stop();
    }

    return nodes;
  }
}
