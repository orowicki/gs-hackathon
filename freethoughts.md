# general ideas
- we want this to be natively compatibe with llms so users can just ask claude to do it


# adding new schema

- parse example alert into schema (allow to tweak)
- ui schema editor (for noneng), maybe nice drag and drop type shit
- engineer facing pure yaml (or toml or whatever we use)
- import button of some kind

# adding new source 

- we have fixed three or so source types
- ui way to add a new one (easy to use)
- maybe also pure yaml again or whatever (probably needed for claude anyway?)
- import button of some kind too?

# adding new source types

- left for now, maybe if bandwith allows (maybe try to build to make it at least kind of viable? dont know if thats worth it) 
- if doing it, probably plugin of some kind

# rules

- add an option to have an inline filter editor for the power user to use in the ui to only see the relevant alerts (powered by the existing rule system so should be easy) (preferences can be saved)
- thought out ux to support complex rules editing
- maybe a way to parse rules as text as well (would support llms better probably)

# alerts channel

- support a few out of the box maybe, UI first, others lower priority (we can simulate for demo)
- code should be made abstract enough to satisfy the 'adding a real provider would be a small, isolated change' requirement, maybe even plugin type if possible
- retries as in the spec

# ui

- rules control ui? so like preset options set it in the rule
- alert dashboard, config window, anything else thatll be needed

# runbooks

- we dont really get it right now
- lets first aim for minimal scope
- we can get back to it later


