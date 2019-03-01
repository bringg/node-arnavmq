.PHONY: test

deps:
	npm install

init:
	docker pull rabbitmq:3.6
	cp .env.tpl .env

run:
	npm run start

lint:
	npm run lint

cover:
	make lint
	npm run cover

test:
	npm run test

sonar:
	sed '/sonar.projectVersion/d' ./sonar-project.properties > tmp && mv tmp sonar-project.properties
	echo sonar.projectVersion=`cat package.json | python -c "import json,sys;obj=json.load(sys.stdin);print obj['version'];"` >> sonar-project.properties
	wget https://d3ayv6nsn4rwn3.cloudfront.net/utilities/sonar-scanner-cli.zip
	unzip sonar-scanner-*
ifdef CIRCLE_PULL_REQUEST
	@sonar-scanner/bin/sonar-scanner -e -Dsonar.analysis.mode=preview -Dsonar.github.pullRequest=${shell basename $(CIRCLE_PULL_REQUEST)} -Dsonar.github.repository=$(REPO_SLUG) -Dsonar.github.oauth=$(GITHUB_TOKEN) -Dsonar.login=$(SONAR_LOGIN) -Dsonar.password=$(SONAR_PASS) -Dsonar.host.url=$(SONAR_HOST_URL)
endif
ifeq ($(CIRCLE_BRANCH),develop)
	@sonar-scanner/bin/sonar-scanner -e -Dsonar.analysis.mode=publish -Dsonar.host.url=$(SONAR_HOST_URL) -Dsonar.login=$(SONAR_LOGIN) -Dsonar.password=$(SONAR_PASS)
endif
	rm -rf sonar-scanner*
