package com.iol.video.web;

import io.github.resilience4j.circuitbreaker.CallNotPermittedException;
import java.util.Map;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.TimeoutException;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.MethodArgumentNotValidException;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;

/**
 * Mapea excepciones de dominio y de infraestructura (resilience/MinIO) a respuestas HTTP con cuerpo
 * JSON {@code { "error": "..." }}.
 */
@RestControllerAdvice
public class RestExceptionHandler {

  @ExceptionHandler(IllegalArgumentException.class)
  public ResponseEntity<Map<String, String>> badRequest(IllegalArgumentException e) {
    return ResponseEntity.status(HttpStatus.BAD_REQUEST)
        .body(Map.of("error", e.getMessage() != null ? e.getMessage() : "Bad request"));
  }

  @ExceptionHandler(IllegalStateException.class)
  public ResponseEntity<Map<String, String>> conflict(IllegalStateException e) {
    return ResponseEntity.status(HttpStatus.CONFLICT)
        .body(Map.of("error", e.getMessage() != null ? e.getMessage() : "Conflict"));
  }

  @ExceptionHandler(SecurityException.class)
  public ResponseEntity<Map<String, String>> forbidden(SecurityException e) {
    return ResponseEntity.status(HttpStatus.FORBIDDEN)
        .body(Map.of("error", e.getMessage() != null ? e.getMessage() : "Forbidden"));
  }

  @ExceptionHandler(CallNotPermittedException.class)
  public ResponseEntity<Map<String, String>> circuitOpen(CallNotPermittedException e) {
    return ResponseEntity.status(HttpStatus.SERVICE_UNAVAILABLE)
        .body(Map.of("error", "Storage temporarily unavailable"));
  }

  @ExceptionHandler(TimeoutException.class)
  public ResponseEntity<Map<String, String>> timeout(TimeoutException e) {
    return ResponseEntity.status(HttpStatus.GATEWAY_TIMEOUT)
        .body(Map.of("error", "Storage request timed out"));
  }

  /**
   * {@link java.util.concurrent.Future#get} envuelve fallos en {@code ExecutionException}; aquí se
   * desempaqueta la causa para reutilizar los mismos códigos que timeout/circuito abierto.
   */
  @ExceptionHandler(ExecutionException.class)
  public ResponseEntity<Map<String, String>> execution(ExecutionException e) {
    Throwable c = e.getCause();
    if (c instanceof TimeoutException te) {
      return timeout(te);
    }
    if (c instanceof CallNotPermittedException cn) {
      return circuitOpen(cn);
    }
    return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR)
        .body(
            Map.of(
                "error",
                c != null && c.getMessage() != null ? c.getMessage() : "Internal error"));
  }

  @ExceptionHandler(MethodArgumentNotValidException.class)
  public ResponseEntity<Map<String, String>> validation(MethodArgumentNotValidException e) {
    String msg =
        e.getBindingResult().getFieldErrors().stream()
            .findFirst()
            .map(f -> f.getField() + ": " + f.getDefaultMessage())
            .orElse("Validation failed");
    return ResponseEntity.status(HttpStatus.BAD_REQUEST).body(Map.of("error", msg));
  }

  @ExceptionHandler(Exception.class)
  public ResponseEntity<Map<String, String>> other(Exception e) {
    return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR)
        .body(Map.of("error", e.getMessage() != null ? e.getMessage() : "Internal error"));
  }
}
