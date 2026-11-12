#!/bin/sh
# Writes the test certificates the mock API server presents (helper-scenarios S-CONN-01).
# Needs OpenSSL 3.4 or later for the fixed validity range of expired.pem. Run it from any folder;
# it writes next to itself and replaces the files below.
#
# Validity of each certificate:
#   root-ca.pem           root CA, valid for 50 years from the day it is made
#   intermediate.pem      intermediate CA signed by the root, valid for 50 years
#   server.pem            localhost and 127.0.0.1, signed by the intermediate, valid for 50 years;
#                         server-chain.pem adds the intermediate, server.pem alone is the chain
#                         whose intermediate the server does not send
#   other-host.pem        other-host.invalid only, signed by the intermediate, valid for 50 years;
#                         other-host-chain.pem adds the intermediate
#   expired.pem           localhost and 127.0.0.1, signed by the intermediate, valid from
#                         2000-01-01 to 2001-01-01 (fixed, in the past); expired-chain.pem adds
#                         the intermediate
#   self-signed.pem       localhost and 127.0.0.1, signed by itself, valid for 50 years
#
# Clients trust root-ca.pem only.

set -eu

cd "$(dirname "$0")"

FIFTY_YEARS=18262
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

version=$(openssl version | awk '{print $2}')
case "$version" in
  3.[4-9]* | 3.[1-9][0-9]* | [4-9].*) ;;
  *)
    echo "make.sh needs OpenSSL 3.4 or later (found $version)" >&2
    exit 1
    ;;
esac

key() {
  openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out "$1" 2>/dev/null
}

# extensions <file> <kind> [subjectAltName]; kinds: root, intermediate, leaf, self-signed
extensions() {
  case "$2" in
    root)
      printf '%s\n' \
        'basicConstraints = critical, CA:TRUE' \
        'keyUsage = critical, keyCertSign, cRLSign' \
        'subjectKeyIdentifier = hash' >"$1"
      ;;
    intermediate)
      printf '%s\n' \
        'basicConstraints = critical, CA:TRUE, pathlen:0' \
        'keyUsage = critical, keyCertSign, cRLSign' \
        'subjectKeyIdentifier = hash' \
        'authorityKeyIdentifier = keyid:always' >"$1"
      ;;
    leaf | self-signed)
      printf '%s\n' \
        'basicConstraints = critical, CA:FALSE' \
        'keyUsage = critical, digitalSignature' \
        'extendedKeyUsage = serverAuth' \
        "subjectAltName = $3" \
        'subjectKeyIdentifier = hash' >"$1"
      if [ "$2" = leaf ]; then
        echo 'authorityKeyIdentifier = keyid:always' >>"$1"
      fi
      ;;
  esac
}

# self_sign <name> <subject> <kind> [subjectAltName]
self_sign() {
  key "$1.key"
  extensions "$work/$1.ext" "$3" "${4:-}"
  openssl req -new -key "$1.key" -subj "/CN=$2" -out "$work/$1.csr"
  openssl x509 -req -in "$work/$1.csr" -signkey "$1.key" -days "$FIFTY_YEARS" -sha256 \
    -extfile "$work/$1.ext" -out "$1.pem" 2>/dev/null
}

# sign <name> <subject> <kind> <issuer> <validity options> [subjectAltName]
sign() {
  name=$1 subject=$2 kind=$3 issuer=$4 validity=$5
  key "$name.key"
  extensions "$work/$name.ext" "$kind" "${6:-}"
  openssl req -new -key "$name.key" -subj "/CN=$subject" -out "$work/$name.csr"
  # shellcheck disable=SC2086 # the validity options are separate words
  openssl x509 -req -in "$work/$name.csr" -CA "$issuer.pem" -CAkey "$issuer.key" \
    -set_serial "0x$(openssl rand -hex 8)" $validity -sha256 \
    -extfile "$work/$name.ext" -out "$name.pem" 2>/dev/null
}

LOCAL='DNS:localhost, IP:127.0.0.1'

self_sign root-ca 'Test Root CA' root
sign intermediate 'Test Intermediate CA' intermediate root-ca "-days $FIFTY_YEARS"
sign server localhost leaf intermediate "-days $FIFTY_YEARS" "$LOCAL"
sign other-host other-host.invalid leaf intermediate "-days $FIFTY_YEARS" 'DNS:other-host.invalid'
sign expired localhost leaf intermediate \
  '-not_before 20000101000000Z -not_after 20010101000000Z' "$LOCAL"

self_sign self-signed localhost self-signed "$LOCAL"

cat server.pem intermediate.pem >server-chain.pem
cat other-host.pem intermediate.pem >other-host-chain.pem
cat expired.pem intermediate.pem >expired-chain.pem
