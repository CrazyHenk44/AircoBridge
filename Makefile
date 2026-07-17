.PHONY: setup build up up-local update down logs ps check

setup:
	cp -n .env.example .env || true
	cp -n config/aircos.example.json config/aircos.json || true
	chmod 600 config/aircos.json
	mkdir -p data

build:
	docker build -t airco:local .

up:
	docker compose up -d

up-local: build
	AIRCO_IMAGE=airco:local docker compose up -d

update:
	docker compose pull
	docker compose up -d

down:
	docker compose down

logs:
	docker compose logs -f airco

ps:
	docker compose ps

check:
	npm run check
