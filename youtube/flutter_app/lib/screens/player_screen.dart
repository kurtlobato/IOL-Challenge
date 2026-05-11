import 'dart:async';
import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:http/http.dart' as http;
import 'package:video_player/video_player.dart';
import 'package:wakelock_plus/wakelock_plus.dart';

import '../models/video_item.dart';
import '../providers/app_providers.dart';

class PlayerScreen extends ConsumerStatefulWidget {
  const PlayerScreen({super.key, required this.video});

  final VideoItem video;

  @override
  ConsumerState<PlayerScreen> createState() => _PlayerScreenState();
}

class _PlayerScreenState extends ConsumerState<PlayerScreen> {
  VideoPlayerController? _controller;
  Timer? _viewTimer;
  Timer? _hideControlsTimer;
  int _lastReportedSeconds = 0;
  bool _showControls = true;
  double _volume = 1.0;
  
  SubtitleItem? _currentSubtitle;
  final FocusNode _mainFocusNode = FocusNode();

  @override
  void initState() {
    super.initState();
    _bootstrap();
    _startHideControlsTimer();
  }

  Future<void> _bootstrap() async {
    await _initController();
    
    final viewerKey = await ref.read(viewerKeyProvider.future);
    if (!mounted) return;
    _viewTimer = Timer.periodic(const Duration(seconds: 20), (_) {
      unawaited(_reportView(viewerKey));
    });
  }

  Future<void> _initController() async {
    final uri = widget.video.playbackUri;
    if (uri == null || uri.isEmpty) return;

    // Si hay un subtítulo seleccionado, lo cargamos
    Future<ClosedCaptionFile>? captionFile;
    if (_currentSubtitle != null) {
      captionFile = _loadSubtitle(_currentSubtitle!.url);
    }

    final oldController = _controller;
    final position = oldController?.value.position ?? Duration.zero;

    final c = VideoPlayerController.networkUrl(
      Uri.parse(uri),
      closedCaptionFile: captionFile,
    );
    
    _controller = c;
    try {
      await c.initialize();
      c.addListener(_onVideoUpdate);
      _volume = c.value.volume;
      await c.seekTo(position);
      await c.play();
      await WakelockPlus.enable();
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('Error: $e')),
        );
      }
    }

    if (oldController != null) {
      oldController.removeListener(_onVideoUpdate);
      // Pequeño delay para evitar parpadeo antes de dispose
      Future.delayed(const Duration(milliseconds: 200), () => oldController.dispose());
    }
    
    if (mounted) setState(() {});
  }

  Future<ClosedCaptionFile> _loadSubtitle(String url) async {
    try {
      final response = await http.get(Uri.parse(url));
      if (response.statusCode == 200) {
        final content = utf8.decode(response.bodyBytes);
        return _SrtCaptionFile(content);
      }
    } catch (e) {
      debugPrint('Error loading subtitle: $e');
    }
    return _EmptyCaptionFile();
  }

  void _onVideoUpdate() {
    if (mounted) setState(() {});
  }

  void _startHideControlsTimer() {
    _hideControlsTimer?.cancel();
    _hideControlsTimer = Timer(const Duration(seconds: 5), () {
      if (mounted && _controller != null && _controller!.value.isPlaying) {
        setState(() {
          _showControls = false;
        });
      }
    });
  }

  void _showControlsTemporarily() {
    if (!_showControls) {
      setState(() {
        _showControls = true;
      });
    }
    _startHideControlsTimer();
  }

  void _togglePlayPause() {
    final c = _controller;
    if (c == null) return;
    setState(() {
      if (c.value.isPlaying) {
        c.pause();
      } else {
        c.play();
      }
    });
    _showControlsTemporarily();
  }

  void _selectSubtitle(SubtitleItem? sub) {
    if (_currentSubtitle == sub) return;
    setState(() {
      _currentSubtitle = sub;
    });
    _initController(); // Reinicializar para cargar el nuevo subtítulo
    _showControlsTemporarily();
  }

  Future<void> _reportView(String viewerKey) async {
    final c = _controller;
    final api = ref.read(lanflixApiProvider);
    if (c == null || !c.value.isInitialized || api == null) return;
    final sec = c.value.position.inSeconds;
    if (sec <= _lastReportedSeconds) return;
    _lastReportedSeconds = sec;
    try {
      await api.recordViewForVideo(widget.video, viewerKey, sec);
    } catch (_) {}
  }

  @override
  void dispose() {
    _viewTimer?.cancel();
    _hideControlsTimer?.cancel();
    _mainFocusNode.dispose();
    WakelockPlus.disable();
    _controller?.removeListener(_onVideoUpdate);
    _controller?.dispose();
    super.dispose();
  }

  String _formatDuration(Duration duration) {
    String twoDigits(int n) => n.toString().padLeft(2, '0');
    final hours = duration.inHours;
    final minutes = twoDigits(duration.inMinutes.remainder(60));
    final seconds = twoDigits(duration.inSeconds.remainder(60));
    return hours > 0 ? "$hours:$minutes:$seconds" : "$minutes:$seconds";
  }

  void _seekRelative(int seconds) {
    if (_controller == null) return;
    final target = _controller!.value.position + Duration(seconds: seconds);
    _controller!.seekTo(target);
    _showControlsTemporarily();
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final c = _controller;
    final isInitialized = c != null && c.value.isInitialized;

    return Scaffold(
      backgroundColor: Colors.black,
      body: Focus(
        focusNode: _mainFocusNode,
        autofocus: true,
        onKeyEvent: (node, event) {
          if (event is KeyDownEvent) {
            _showControlsTemporarily();
            if (event.logicalKey == LogicalKeyboardKey.select ||
                event.logicalKey == LogicalKeyboardKey.enter ||
                event.logicalKey == LogicalKeyboardKey.space) {
              _togglePlayPause();
              return KeyEventResult.handled;
            } else if (event.logicalKey == LogicalKeyboardKey.arrowLeft) {
              _seekRelative(-10);
              return KeyEventResult.handled;
            } else if (event.logicalKey == LogicalKeyboardKey.arrowRight) {
              _seekRelative(10);
              return KeyEventResult.handled;
            } else if (event.logicalKey == LogicalKeyboardKey.escape ||
                       event.logicalKey == LogicalKeyboardKey.backspace) {
              if (_showControls) {
                setState(() => _showControls = false);
              } else {
                Navigator.of(context).pop();
              }
              return KeyEventResult.handled;
            }
          }
          return KeyEventResult.ignored;
        },
        child: GestureDetector(
          onTap: _showControlsTemporarily,
          behavior: HitTestBehavior.opaque,
          child: Stack(
            fit: StackFit.expand,
            children: [
              if (isInitialized)
                Center(
                  child: AspectRatio(
                    aspectRatio: c.value.aspectRatio == 0 ? 16 / 9 : c.value.aspectRatio,
                    child: VideoPlayer(c),
                  ),
                )
              else
                const Center(child: CircularProgressIndicator(color: Colors.white24)),

              // Subtitles Layer (Built-in Flutter VideoPlayer display)
              if (isInitialized && _currentSubtitle != null)
                Positioned(
                  bottom: _showControls ? 140 : 40,
                  left: 20,
                  right: 20,
                  child: ClosedCaption(
                    text: c.value.caption.text,
                    textStyle: const TextStyle(
                      fontSize: 24,
                      color: Colors.white,
                      backgroundColor: Colors.black54,
                    ),
                  ),
                ),

              // Controls Overlay
              if (isInitialized)
                IgnorePointer(
                  ignoring: !_showControls,
                  child: AnimatedOpacity(
                    opacity: _showControls ? 1.0 : 0.0,
                    duration: const Duration(milliseconds: 300),
                    child: Container(
                      decoration: BoxDecoration(
                        gradient: LinearGradient(
                          begin: Alignment.topCenter,
                          end: Alignment.bottomCenter,
                          colors: [
                            Colors.black.withOpacity(0.9),
                            Colors.transparent,
                            Colors.transparent,
                            Colors.black.withOpacity(0.9),
                          ],
                          stops: const [0.0, 0.25, 0.75, 1.0],
                        ),
                      ),
                      child: Stack(
                        children: [
                          // Top Bar
                          Positioned(
                            top: 0,
                            left: 0,
                            right: 0,
                            child: SafeArea(
                              child: Padding(
                                padding: const EdgeInsets.symmetric(horizontal: 32, vertical: 24),
                                child: Row(
                                  children: [
                                    IconButton(
                                      icon: const Icon(Icons.close, color: Colors.white, size: 32),
                                      onPressed: () => Navigator.of(context).pop(),
                                    ),
                                    const SizedBox(width: 16),
                                    Expanded(
                                      child: Column(
                                        crossAxisAlignment: CrossAxisAlignment.start,
                                        children: [
                                          Text(
                                            widget.video.title,
                                            style: const TextStyle(
                                              color: Colors.white,
                                              fontSize: 22,
                                              fontWeight: FontWeight.bold,
                                            ),
                                            maxLines: 1,
                                            overflow: TextOverflow.ellipsis,
                                          ),
                                          if (widget.video.nodeName != null)
                                            Text(
                                              'Nodo: ${widget.video.nodeName!}',
                                              style: TextStyle(
                                                color: Colors.white.withOpacity(0.5),
                                                fontSize: 14,
                                              ),
                                            ),
                                        ],
                                      ),
                                    ),
                                    // Subtitles Button
                                    if (widget.video.subtitles.isNotEmpty)
                                      _SubtitleSelector(
                                        options: widget.video.subtitles,
                                        selected: _currentSubtitle,
                                        onSelected: _selectSubtitle,
                                      ),
                                  ],
                                ),
                              ),
                            ),
                          ),

                          // Center Controls
                          Center(
                            child: Row(
                              mainAxisAlignment: MainAxisAlignment.center,
                              children: [
                                _ControlButton(
                                  icon: Icons.replay_10,
                                  onTap: () => _seekRelative(-10),
                                ),
                                const SizedBox(width: 56),
                                _ControlButton(
                                  icon: c.value.isPlaying ? Icons.pause : Icons.play_arrow,
                                  size: 84,
                                  isPrimary: true,
                                  onTap: _togglePlayPause,
                                ),
                                const SizedBox(width: 56),
                                _ControlButton(
                                  icon: Icons.forward_10,
                                  onTap: () => _seekRelative(10),
                                ),
                              ],
                            ),
                          ),

                          // Bottom Bar
                          Positioned(
                            bottom: 0,
                            left: 0,
                            right: 0,
                            child: SafeArea(
                              child: Padding(
                                padding: const EdgeInsets.fromLTRB(48, 0, 48, 48),
                                child: Column(
                                  mainAxisSize: MainAxisSize.min,
                                  children: [
                                    SliderTheme(
                                      data: SliderTheme.of(context).copyWith(
                                        trackHeight: 6,
                                        thumbShape: const RoundSliderThumbShape(enabledThumbRadius: 8),
                                        activeTrackColor: theme.colorScheme.primary,
                                        inactiveTrackColor: Colors.white24,
                                        thumbColor: theme.colorScheme.primary,
                                      ),
                                      child: Slider(
                                        value: c.value.position.inSeconds.toDouble(),
                                        max: c.value.duration.inSeconds.toDouble().clamp(1, double.infinity),
                                        onChanged: (val) {
                                          c.seekTo(Duration(seconds: val.toInt()));
                                          _showControlsTemporarily();
                                        },
                                      ),
                                    ),
                                    const SizedBox(height: 8),
                                    Padding(
                                      padding: const EdgeInsets.symmetric(horizontal: 16),
                                      child: Row(
                                        mainAxisAlignment: MainAxisAlignment.spaceBetween,
                                        children: [
                                          Text(_formatDuration(c.value.position), style: const TextStyle(color: Colors.white, fontSize: 16)),
                                          Text(_formatDuration(c.value.duration), style: const TextStyle(color: Colors.white, fontSize: 16)),
                                        ],
                                      ),
                                    ),
                                  ],
                                ),
                              ),
                            ),
                          ),
                        ],
                      ),
                    ),
                  ),
                ),
            ],
          ),
        ),
      ),
    );
  }
}

class _SubtitleSelector extends StatelessWidget {
  final List<SubtitleItem> options;
  final SubtitleItem? selected;
  final Function(SubtitleItem?) onSelected;

  const _SubtitleSelector({
    required this.options,
    required this.selected,
    required this.onSelected,
  });

  @override
  Widget build(BuildContext context) {
    return PopupMenuButton<SubtitleItem?>(
      icon: Icon(
        selected != null ? Icons.closed_caption : Icons.closed_caption_disabled,
        color: selected != null ? Theme.of(context).colorScheme.primary : Colors.white,
        size: 32,
      ),
      tooltip: 'Subtítulos',
      onSelected: onSelected,
      color: const Color(0xFF222222),
      itemBuilder: (context) => [
        const PopupMenuItem<SubtitleItem?>(
          value: null,
          child: Text('Desactivados', style: TextStyle(color: Colors.white)),
        ),
        ...options.map((s) => PopupMenuItem<SubtitleItem?>(
          value: s,
          child: Text(s.label, style: TextStyle(
            color: s == selected ? Theme.of(context).colorScheme.primary : Colors.white,
          )),
        )),
      ],
    );
  }
}

class _ControlButton extends StatelessWidget {
  final IconData icon;
  final double size;
  final VoidCallback onTap;
  final bool isPrimary;

  const _ControlButton({
    required this.icon,
    this.size = 52,
    required this.onTap,
    this.isPrimary = false,
  });

  @override
  Widget build(BuildContext context) {
    return Material(
      color: Colors.transparent,
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(size),
        child: Container(
          padding: const EdgeInsets.all(12),
          decoration: BoxDecoration(
            shape: BoxShape.circle,
            color: isPrimary ? Colors.white.withOpacity(0.2) : Colors.white.withOpacity(0.05),
            border: isPrimary ? Border.all(color: Colors.white24, width: 2) : null,
          ),
          child: Icon(icon, color: Colors.white, size: size),
        ),
      ),
    );
  }
}

// Minimal SRT Parser
class _SrtCaptionFile extends ClosedCaptionFile {
  _SrtCaptionFile(String content) : _captions = _parseSrt(content);
  final List<Caption> _captions;
  @override
  List<Caption> get captions => _captions;

  static List<Caption> _parseSrt(String content) {
    final List<Caption> captions = [];
    final List<String> blocks = content.split('\n\n');
    for (var block in blocks) {
      final lines = block.trim().split('\n');
      if (lines.length >= 3) {
        final times = lines[1].split(' --> ');
        if (times.length == 2) {
          final start = _parseSrtTime(times[0]);
          final end = _parseSrtTime(times[1]);
          final text = lines.sublist(2).join('\n');
          captions.add(Caption(number: captions.length, start: start, end: end, text: text));
        }
      }
    }
    return captions;
  }

  static Duration _parseSrtTime(String s) {
    final parts = s.split(':');
    final secondsParts = parts[2].split(',');
    return Duration(
      hours: int.parse(parts[0]),
      minutes: int.parse(parts[1]),
      seconds: int.parse(secondsParts[0]),
      milliseconds: int.parse(secondsParts[1]),
    );
  }
}

class _EmptyCaptionFile extends ClosedCaptionFile {
  @override
  List<Caption> get captions => const [];
}
