.PHONY: up down restart logs

up:
	docker compose -f youtube/docker-compose.yml up --build -d

down:
	docker compose -f youtube/docker-compose.yml down

restart:
	docker compose -f youtube/docker-compose.yml restart

logs:
	docker compose -f youtube/docker-compose.yml logs -f
