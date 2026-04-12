package com.iol.video;

import static org.junit.jupiter.api.Assertions.assertEquals;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.client.TestRestTemplate;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.testcontainers.containers.GenericContainer;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;

@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@Testcontainers(disabledWithoutDocker = true)
class ActuatorHealthIntegrationTest {

  @Container
  static PostgreSQLContainer<?> postgres =
      new PostgreSQLContainer<>(DockerImageName.parse("postgres:16-alpine"))
          .withDatabaseName("videodb")
          .withUsername("iol")
          .withPassword("iol");

  @Container
  static GenericContainer<?> minio =
      new GenericContainer<>(DockerImageName.parse("minio/minio:latest"))
          .withExposedPorts(9000)
          .withCommand("server", "/data")
          .withEnv("MINIO_ROOT_USER", "minioadmin")
          .withEnv("MINIO_ROOT_PASSWORD", "minioadmin");

  @DynamicPropertySource
  static void registerProps(DynamicPropertyRegistry r) {
    r.add("spring.datasource.url", postgres::getJdbcUrl);
    r.add("spring.datasource.username", postgres::getUsername);
    r.add("spring.datasource.password", postgres::getPassword);
    r.add("minio.endpoint", () -> "http://" + minio.getHost() + ":" + minio.getMappedPort(9000));
    r.add("minio.access-key", () -> "minioadmin");
    r.add("minio.secret-key", () -> "minioadmin");
    r.add("app.transcode.poll-ms", () -> 999_999_999L);
    r.add("spring.task.scheduling.enabled", () -> "false");
  }

  @Autowired private TestRestTemplate restTemplate;

  @Test
  void actuatorHealthReturns200() {
    ResponseEntity<String> res = restTemplate.getForEntity("/actuator/health", String.class);
    assertEquals(HttpStatus.OK, res.getStatusCode());
  }

  @Test
  void actuatorPrometheusReturns200() {
    ResponseEntity<String> res = restTemplate.getForEntity("/actuator/prometheus", String.class);
    assertEquals(HttpStatus.OK, res.getStatusCode());
  }
}
