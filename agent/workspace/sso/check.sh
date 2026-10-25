#!/bin/sh
# Prints NO_REPLY when calm, else the storm alert (and marks it sent).
. "$(dirname "$0")/lib.sh"
get /check
