import 'dart:async';
import 'package:flutter/material.dart';
import 'package:video_player/video_player.dart';

class PosterCard extends StatefulWidget {
  const PosterCard({
    super.key,
    required this.title,
    this.subtitle,
    this.imageUrl,
    this.videoUrl,
    this.onTap,
    this.onFocusChange,
    this.focusNode,
    this.badge,
    this.metadata,
  });

  final String title;
  final String? subtitle;
  final String? imageUrl;
  final String? videoUrl;
  final VoidCallback? onTap;
  final void Function(bool)? onFocusChange;
  final FocusNode? focusNode;
  final String? badge;
  final String? metadata;

  @override
  State<PosterCard> createState() => _PosterCardState();
}

class _PosterCardState extends State<PosterCard> {
  late FocusNode _focusNode;
  bool _isFocused = false;
  
  VideoPlayerController? _controller;
  Timer? _previewTimer;
  bool _showPreview = false;

  @override
  void initState() {
    super.initState();
    _focusNode = widget.focusNode ?? FocusNode();
    _focusNode.addListener(_onFocusChange);
  }

  void _onFocusChange() {
    setState(() {
      _isFocused = _focusNode.hasFocus;
    });

    if (_isFocused) {
      _startPreviewTimer();
    } else {
      _stopPreview();
    }

    widget.onFocusChange?.call(_focusNode.hasFocus);
  }

  void _startPreviewTimer() {
    _previewTimer?.cancel();
    if (widget.videoUrl == null || widget.videoUrl!.isEmpty) return;

    _previewTimer = Timer(const Duration(milliseconds: 800), () {
      if (_isFocused && mounted) {
        _initializePreview();
      }
    });
  }

  Future<void> _initializePreview() async {
    if (widget.videoUrl == null) return;
    
    _controller = VideoPlayerController.networkUrl(Uri.parse(widget.videoUrl!));
    try {
      await _controller!.initialize();
      if (mounted && _isFocused) {
        await _controller!.setVolume(0); // Muted preview
        await _controller!.setLooping(true);
        await _controller!.play();
        setState(() {
          _showPreview = true;
        });
      } else {
        _controller?.dispose();
        _controller = null;
      }
    } catch (e) {
      debugPrint('Error initializing preview: $e');
      _controller?.dispose();
      _controller = null;
    }
  }

  void _stopPreview() {
    _previewTimer?.cancel();
    _previewTimer = null;
    setState(() {
      _showPreview = false;
    });
    _controller?.dispose();
    _controller = null;
  }

  @override
  void dispose() {
    _previewTimer?.cancel();
    _controller?.dispose();
    if (widget.focusNode == null) {
      _focusNode.dispose();
    } else {
      _focusNode.removeListener(_onFocusChange);
    }
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return AnimatedScale(
      scale: _isFocused ? 1.08 : 1.0,
      duration: const Duration(milliseconds: 150),
      curve: Curves.easeOutCubic,
      child: SizedBox(
        width: 260,
        child: Material(
          color: Colors.transparent,
          borderRadius: BorderRadius.circular(4),
          clipBehavior: Clip.antiAlias,
          child: InkWell(
            focusNode: _focusNode,
            onTap: widget.onTap,
            focusColor: Colors.white.withOpacity(0.1),
            splashColor: theme.colorScheme.primary.withOpacity(0.3),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                // Thumbnail / Preview Area
                AspectRatio(
                  aspectRatio: 16 / 9,
                  child: Container(
                    decoration: BoxDecoration(
                      color: const Color(0xFF1F1F1F),
                      borderRadius: BorderRadius.circular(4),
                      border: _isFocused
                          ? Border.all(
                              color: Colors.white,
                              width: 2,
                            )
                          : null,
                      boxShadow: _isFocused
                          ? [
                              BoxShadow(
                                color: Colors.white.withOpacity(0.2),
                                blurRadius: 12,
                                spreadRadius: 2,
                              )
                            ]
                          : null,
                    ),
                    clipBehavior: Clip.antiAlias,
                    child: Stack(
                      fit: StackFit.expand,
                      children: [
                        // Static Thumbnail
                        if (widget.imageUrl != null && widget.imageUrl!.isNotEmpty)
                          Image.network(
                            widget.imageUrl!,
                            fit: BoxFit.cover,
                            gaplessPlayback: true,
                            errorBuilder: (_, __, ___) => _placeholder(theme),
                          )
                        else
                          _placeholder(theme),
                        
                        // Video Preview Overlay
                        if (_showPreview && _controller != null && _controller!.value.isInitialized)
                          AnimatedOpacity(
                            opacity: _showPreview ? 1.0 : 0.0,
                            duration: const Duration(milliseconds: 300),
                            child: VideoPlayer(_controller!),
                          ),

                        // Badge Overlay
                        if (widget.badge != null)
                          Positioned(
                            right: 8,
                            bottom: 8,
                            child: Container(
                              padding: const EdgeInsets.symmetric(
                                horizontal: 6,
                                vertical: 2,
                              ),
                              decoration: BoxDecoration(
                                color: Colors.black.withOpacity(0.8),
                                borderRadius: BorderRadius.circular(2),
                              ),
                              child: Text(
                                widget.badge!,
                                style: const TextStyle(
                                  color: Colors.white,
                                  fontSize: 10,
                                  fontWeight: FontWeight.bold,
                                ),
                              ),
                            ),
                          ),
                      ],
                    ),
                  ),
                ),
                const SizedBox(height: 10),
                // Info Area
                Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Container(
                      margin: const EdgeInsets.only(top: 2),
                      decoration: BoxDecoration(
                        color: theme.colorScheme.primary,
                        shape: BoxShape.circle,
                      ),
                      padding: const EdgeInsets.all(4),
                      child: Icon(
                        widget.badge != null ? Icons.folder : Icons.play_arrow,
                        size: 14,
                        color: Colors.white,
                      ),
                    ),
                    const SizedBox(width: 10),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            widget.title,
                            maxLines: 2,
                            overflow: TextOverflow.ellipsis,
                            style: TextStyle(
                              fontSize: 14,
                              fontWeight:
                                  _isFocused ? FontWeight.bold : FontWeight.w600,
                              color: Colors.white,
                            ),
                          ),
                          if (widget.subtitle != null &&
                              widget.subtitle!.isNotEmpty)
                            Text(
                              widget.subtitle!,
                              maxLines: 1,
                              style: TextStyle(
                                fontSize: 12,
                                color: Colors.white.withOpacity(0.7),
                              ),
                            ),
                          if (widget.metadata != null)
                            Padding(
                              padding: const EdgeInsets.only(top: 2),
                              child: Text(
                                widget.metadata!,
                                maxLines: 2,
                                style: TextStyle(
                                  fontSize: 11,
                                  color: Colors.white.withOpacity(0.5),
                                ),
                              ),
                            ),
                        ],
                      ),
                    ),
                  ],
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }

  Widget _placeholder(ThemeData theme) {
    return Center(
      child: Icon(
        Icons.movie_outlined,
        size: 40,
        color: Colors.white.withOpacity(0.1),
      ),
    );
  }
}
