I spend a lot of time talking about the best ways to build. It's kind of my
whole thing. I'm really nerdy about the details of how we architect software,
but things have changed and how we build matters less in a lot of ways. What
still matters and arguably always has is what we're building. Deciding on good
projects to work on is hard and I know a lot of people are scared that if they
pick the wrong thing, they're just wasting their time and energy. I've always
loved giving advice on how to avoid this. I usually focus on one specific thing.
Solve problems that you actually have. When you start solving those problems,
you'll find more and then the rabbit hole continues until eventually you find
something actually really useful. And that's how I have managed to build such
cool things throughout my career. I start with one problem and then I find
another and then I find another and I keep yak shaving until eventually I've
built something kind of cool. But in a world where ideas suddenly matter a
little bit more, getting them right might seem even scarier than it did in the
past. And I've read my comment section. I know how many devs are struggling to
figure out what they should be building right now. I have good news for you
guys. I have a list. I have been keeping a list of ideas that I wished somebody
would build for a long time. And as much as I want to build them myself, I have
to be realistic. I do not have the time. As powerful as agents are, they make
any one of these projects viable for me. They don't make all of them viable for
me. And I wanted to share some of these ideas because ideas are still cheap. I
don't think I'm special for having a whole bunch of ideas. I don't really think
I'm that special in general. I just like building [ __ ] The point of this is
that I've seen what you guys do when you're given ideas. I watched the chaos
that unfolded when I mentioned how much I like Nieri and how I want a
environment like that to use for coding on my Mac. I've seen all of the insane
things you guys are capable of building when given hints of the types of stuff
that I wish existed. So, I'm going to stop giving hints. I'm just going to give
you all of it. I have all the ideas written down but hidden behind this green
wall and to give you a taste of what I have in mind here. The first idea is
better NPM. I have so much to say about all of these ideas and maybe just maybe
one of these will become an awesome product some of y'all can build. But in
order for me to justify giving all of this away for free, I need to make a
little bit of money off someone else's good idea, which I'm going to do with a
quick break for today's sponsor. Here's a hot take you might not expect for me.
I think it's important that you continue to read your code, especially if you
have agents writing it. But let's be realistic here. No one's reading a PR like
this. 11,000 lines added, come on. AI's resulting in way more of these big PRs
and sure the AI can review it, but you need to know what's going on. Finding the
things that matter in a pile of slop like this is nearly impossible. At the very
least this PR was reviewed already by Code Rabbit. Wait, what's that button?
Review change stack. I've been waiting for this for so long. I've been
complaining forever about how unreadable these giant PRs are and how stupid it
is that we get the code in an alphabetically listed order. It makes no sense
whatsoever. We've been dealing with this for years for no reason. And now Code
Rabbit solved it. They break your PRs up into layers that prioritize the things
that actually matter to make it way easier to read through what happened. You
can mark sections as viewed as you go, which makes it way easier to track what
you've actually looked at. There's even a mini map on the right side that shows
you where different parts that matter are and describes them, which makes it so
much easier to look through this type of work. And it's honestly just so nice to
hover over the different things a PR did and get a summary of what's actually
going on. Honestly, pretty much anything is better than GitHub's code review
platform, but this is night and day difference. Read more code with less pain at
swyd.link/coderabbit. We need to talk about better NPM and also specifically
better NPX because I have so many thoughts here. NPM has problems. It is also an
incredible piece of software and I'm very thankful it exists. We should talk a
bit about the problems with NPM. I'm going to go through this a little fast
because remember, we have a lot of other ideas to go through as well. Obviously,
one of the biggest right now that we are seeing every day is security. NPM by
nature is going to be a big target for hackers and malicious actors. And every
time they find a new way to exploit NPM, it becomes harder for good-intentioned,
good-faith devs to use it as well. Every additional layer they put in makes life
harder for us as devs, and I have been fighting so much to get packages added to
NPM recently. It's regularly becoming the hardest part of the projects in the
products that I'm building. That's kind of the other issue if we're being real
here. Publishing is too hard. And it also has a lot of negative consequences if
you get it wrong. For example, if you accidentally publish the wrong version
number, you're never taking that down. That's out there forever. And even some
really big package maintainers that have accidentally typoed a number on a
version release, for example, something like TanStack Query, has screwed this
up, and now React Query's latest version is just not what it's supposed to be,
and they are not able to revoke that publication because NPM is so paranoid
about an old app that had specific dependencies not being able to be rebuilt
because some of those dependencies vanished years later. These are all
absolutely solvable problems. It's just that changing them right now with the
way NPM works today would come with a lot of risks and potentially damage the
ecosystem and the things we rely on. Just a handful of some things I would like
to see in a new NPM platform. First off, it'd be really cool for revoking
releases at a threshold. For example, if my package has been installed under 100
times or it's been up for under 5 hours, I should be able to revoke it.
Obviously. Similarly, due to the nature of these more malicious things that are
being published, I should be able to pay to audit every release. Why can't I put
in an API for Anthropic or put in a credit card number in NPM so that they will
audit and compare the diffs of every release and give their vibe check as to
whether or not that release is safe or intended. On that note, we need way more
visibility on what the packages do. Not just like what permissions they need,
but things like is this an obfuscated package or is this de-obfuscated? Is this
readable JavaScript or not? Is it open source or not? Is it backed by people we
know? Who published the last release? There should be more metadata associated
with given packages both in like the NPM site when you view it, but also in your
own CLI when you install it. Let's say somebody published a malicious package on
NPM named, I don't know, is odd with a zero instead of an O. There's of course
the real is odd package which you also shouldn't install. But the fact that it
would be possible for somebody to make an is odd with a zero, that is a truly at
its core malicious package that like reads your file system, that accesses your
network, that does a bunch of sketchy [ __ ] it shouldn't, and you would not see
anything different installing that than you would see installing this is a
fundamental design failure in NPM itself. Different packages that have different
needs and different complexity come with different risk, and that risk should be
up front to you when you decide what you're doing. And on that note, people are
already noticing something. Name squatting should be killed. There should be a
person or a series of agents that will verify submissions requesting names that
exist to be handed over to them that does a good enough job vetting that you can
actually deal with this stuff. Fun fact, the TanStack package on NPM isn't owned
by Tanner. It's owned by some dirtbag who was squatting on it trying to get
Tanner to pay a whole bunch of money. And when Tanner refused, he sold it to
some cringey company 30 tools. Might even be his company. I wouldn't recommend
clicking the link. It's probably a scam. This should be illegal. And any real
open source platform that knows a [ __ ] thing about the ecosystem should hard
ban this. But NPM is too busy. Shut the [ __ ] up. They're useless. There's no
excuse for how NPM is not doing their jobs lately. The NPM squad needs to be
absolutely decimated. And on that note, I want to talk a bit about NPX, the
executable part of NPM, because I would argue, potentially controversially, that
this is actually the more fun entry point to rethink things here. If I build a
random script or a tool that my agents need that's a part of their skills or
whatever, distributing that code is annoying. It's really annoying. And I have a
bunch of packages that I don't actually expect people to ever install, but they
are very useful when you use them over NPX. The idea of NPX as a shared
executable layer, similar to how the browser lets you go to different sites to
do different things, NPX lets you use different code to solve different
problems. I really like the idea of going further with NPX. What do I mean by
this? Well, if you run NPX now on any given thing, let's say NPX slot-slop, for
example. Since I've already used this package, it doesn't have to confirm
anything and it's good to go. But if I change this to like at latest or
something, it asks for permission. It needs to install the following package. Is
it okay to proceed? I have to choose yes or no. How the [ __ ] do I know
anything here? What info do I get here? This is so insultingly useless. There is
nothing I can do here to get any info and if what I'm about to do is safe or
not. Imagine it gave how big this app is. Imagine if it gave the author who most
recently changed something. Imagine it gave a score for how likely it thinks
it's safe or not. Imagine it gave you the permissions that it has when it runs.
All I get is this random [ __ ] version number. That's insane. This is such a
useful thing and not just for us as humans running these things by the way, for
our agents, too. One of the real concerns we have now, and we should hold this
concern cuz it's very very real right now, is that if your agents have commands
they can run in a skill.md, for example. There's a skill that says, "Here is a
thing you can do. Here's the command that you run." And that command is an NPX
command, and then somebody maliciously takes over that package, your agent can
entirely unknowingly execute malicious code. Imagine that this put out a little
more info and your agent could read it and make a decision or highlight to you
as the user, "Hey, I was supposed to run this command. I got a heads-up this
might be an insecure thing. What do you want to do about it?" And again, since
the value of this is largely small open-source scripts, imagine that you can pay
a small amount of money to have these things audited so that a security score
comes up when people run them. If you ship a small bit of open-source code and
you pay 50 cents for an agent to read it and give a rough idea of what
likelihood it is to be good or bad, and that is run on a third party that is
verified, because again, you can't just run this on your own computer because
you can fake those results. A rough idea of how risky every install is would be
so useful. It would be so useful. And it would make me want to use NPX way more.
If you combine this with private registries where you can run a command to get
access to a bunch of packages that I have in my environment that are not
publicly released, but you're getting from me in my bucket, that would be so
cool. Like if you and I could both have our own TanStack package or something
that might be different for our use cases. If I could publish to my private
registry, and now that is the default over the public registry, that'd be great.
There There's so many little things here. The idea of shareable software in the
form of packages is incredible, but the architecture we have for it assumes that
every single package was really expensive to make and has a maintainer that's
willing to spend a lot of time dealing with NPM. That is stupid and wrong and
really, really needs to be addressed. Doing this right requires a lot of pieces.
You have to build the integrations for publishing, you have to build the place
that they're published, you have to build the CDN where all of this code exists.
You have to build a platform of verification, you have to build the registries,
you have to build the CLIs, you have to build a lot of [ __ ] for this. But, I
think you can now. That's is why I did the video about building bigger cuz I
want you guys to think this way. Rebuilding NPM made no sense before because it
would be too expensive and probably wouldn't get users. Now, it's a lot cheaper.
Maybe go do it. One more note on this. There are already companies like Socket
that figured out how to use AI to audit new releases and find these exploits
when they happen. Socket figures out when NPM exploits happen before NPM
themselves do. There is so much room to build better things on top of and
instead of NPM. I hope more people take the opportunity. And that's just idea
number one, guys. I know that one seems bold, so let's get to something a little
more reasonable for the next one like uh I don't know, reinventing source
control from scratch. I've been complaining about this one for a while. I don't
think Git is the right abstraction for a lot of things. Git was so much better
than all the source control we had before it that it became the standard. It
became a standard for a good reason. It is so much better than almost anything
else that existed. But, a lot has changed since Git was introduced and both Git
and GitHub feel like they're rotting at the core because the needs they were
built for are very different from the needs we have today. This is going to
sound like a really silly question, but hear me out. Why can't we commit .env
files? Think about this. Think about it deeply. There's an obvious answer here,
which is cuz then everybody who has access to the repo has access to all of your
sensitive environment variables. But why? Well, their answer is cuz that's just
how Git works. When something's in the repo, now everyone has access. And once
it's in the repo, once it's in there forever. If you decide to open source
later, those environment variables are there. If you hire and then fire
somebody, they had those environment variables and they probably still do cuz
you probably didn't give them the file anyways. When you let another team work
on your project, even if they don't need the environment variables, if they're
in the repo, that team has them. You could try to solve this in a gluey way by
adding a service on top of your code base that just manages environment files
and environment variables. And I know a lot of people are doing this. I know
there's a lot of cool companies that have tried to build solutions there. But my
argument is a bit different. The fact that all of these companies for managing
secrets exist, even though in the end what it resolves to is just a [ __ ]
random file on your computer, shows that Git is failing us. This is just one of
the ways in which Git is failing us right now. Why can't I have private files in
my Git repo? Why can't I have some files that only certain people have access to
and everyone else doesn't? Why can't I have a branch that is private? Why can't
I have a pull request that is private until it merges? Or even better, why can't
I delay when my merges go public or are seen by other people on the team? Why is
there no concept of granular permissioning whatsoever on top of Git? There's a
reason for that. The reason is cuz it was built for Linux and none of that was
necessary for the development of Linux. Now it kind of is necessary for Linux
though because when there are critical bugs or safety and security issues in
Linux and they get patched, everyone has agents running that read every patch
and say, "Hey, is there anything in here that might have been a security fix?"
And now you're getting zero days before they're even announced. Imagine if the
Linux team could merge a security fix, cut a release, send it to all of the
people who are maintaining Linux distributions that are vulnerable to the
exploit, and get it all patched before the code itself is even public. Is that
true open source? Nah, probably not. But I don't [ __ ] care anymore. We're in
the middle of a security crisis and we're bickering over where we should store
files still. What the [ __ ] went wrong? Sorry for the slight crash out. I'm
just really mad these problems aren't solved and could kill open source in
spirit if they're not fixed. We need ways to securely merge code and cut
releases without all of that code being visible to the whole world. The idea of
private and public being a repo level setting instead of a change level option
is insane. And Git itself is built deeply around the assumption that the repo is
what has permissions, not the contents of the repo. There have been lots of
attempts to explore what this could look like from Delta DB over at Zed to the
new Origin stuff Cursor just released, but most of it is trying to do stuff like
add more context for the agents to have or stuff like making it easier to clone
the repo so multiple agents can work on it in parallel. None of them are trying
to address the fundamental within Git. I actually made a thread about this a few
weeks ago and I'm going to read through it quick cuz I think it really showcases
what I'm talking about here. I'm using my AI psychosis to fix clouds for agents.
Someone else needs to use their psychosis to fix source control. I would do it
myself, but I'm too deep on the cloud thing. GitHub is dying and Git is not the
right primitive. I'll dump some thoughts here. First, I said open source should
not always mean 100% of our code is public 100% of the time. How much energy do
we have to put into preventing ENV leaks in source control? How many miserable
ways have we reinvented sharing of those instead? How many projects would be
open source if they could hide in flight PR's? I know for example, Cloud Code
would be much more likely to be open source if they didn't have to show all of
the things they were working on all of the time because half the time it doesn't
actually end up shipping and people would have seen that and been annoyed like
it You want to hide the work that isn't done and Git does not let you do that.
How many security fixes are sitting unpublished because they will be exploited
as soon as they appear in the tracker? How much better would life be if I could
have a mono repo with some sub packages that are private without having to split
into multiple repos? Personally, I have had a lot of projects that I had to
break up into multiple repos because I wanted to open source a bunch of them,
but I couldn't open source the whole thing for various reasons. The fact that I
have to shape the way I do work around what I want to share instead of using my
tools to shape what is shared is just stupid. And it's silly that I fixate so
much on this environment variable thing, but we have just become normalized to
this as an obvious thing for no good [ __ ] reason. It's just dumb, but it's how
it works, so we accept it. Going a bit further here, I think commits are bad. I
don't think they're terrible. I think they're a reasonable base unit, but they
don't really work well the way that we're building today, and branches are even
worse. I do really like how JJ does this. I I am resisting the urge to go all in
on JJ at this point because it doesn't solve the problems I care the most about,
but the ones it does solve it solves so well that it feels much better to use.
JJ solved a lot of ergonomic issues of source control management for devs, and I
love it for that. It's what got me thinking more deeply about what would it look
like if we unfucked Git, and a lot of the pieces there are great. The idea of
snapshots and tags instead of branches and commits is so strong. In a world
where we're used to thinking of commits all the time and worrying about our
history constantly, JJ was a breath of fresh air and showed that we're wasting
so much of our time thinking about things that don't matter. On that note, work
trees are atrocious. It is actually hilarious how bad work trees are. I I had a
cloned repo that was annoying to work with a few days ago because one of the
work trees with an agent checked out main, and now I can't check out main in the
actual main directory because one of the random work trees happened to have
taken it hostage. Insanity. Holy [ __ ] it's so bad. I I really don't like work
trees that Git primitive at all. And one last piece, this is where it starts to
get even more controversial. I don't think source control should require real
operating systems or file systems. The fact that you're expected to interface
with Git via a CLI in a real environment with real files is stupid in a world
where we have awesome tools like just bash. If you're not familiar with just
bash, it is a full JavaScript or TypeScript layer that emulates bash so that you
can run an agent like a cloud coder codex type thing without having a real Linux
kernel and a real file system. Instead, it can run entirely inside of memory
inside of JavaScript and not know any better. It's a lot easier to clone [ __ ]
randomly within memory than it is to move files around a whole bunch on your
system. Slight tangent, but I want to vent about this cuz I really want this
fixed and I don't know where else to complain. Novox Populi shared this
benchmark with me earlier this year and it has haunted me since. This is a
benchmark on disk performance for tools like Git across different platforms. He
was replying this to a post I made about how fast the SSDs are on my M5 Mac.
SSDs are super fast. I was really excited for like bulk reads and writes and [
__ ] on this machine. And then I looked at his benchmark. The way this benchmark
works is you clone the project which has a bunch of sub frameworks in it that
are boilerplate that have a bunch of random [ __ ] installed. And the benchmark
is cloning all of this, PNPM installing all of this from cache, and measuring
how long it takes for the files to be created because there is no network access
being done here. Everything's already cached. It's just recreating the contents
in the directories. And the results haunt me. With an old middle-range AMD CPU
and admittedly a lot of RAM, the clean install took 6.8 seconds on Ubuntu to be
clear with a normal Western Digital SSD. On an M4 chip with the really fancy
Apple SSD, the exact same thing took 31 seconds. This appears to be a massive
problem with APFS, which is Apple's file system, where creating a lot of small
files sucks to the point where an M1 Ultra can take upwards of 140 seconds to do
this. 140 seconds for a task that a similar MacBook running Ubuntu instead can
do in 3 to 12 seconds. That's insane. That is actually insane. APFS is garbage.
At the very least, it's garbage at these types of small file read-writes, and
all of these numbers show it. This type of thing just sucks. It's really bad,
and it makes spinning up lots of small environments for your agents to work in.
It is just bad. There is no excuse for it to be this bad. This means that crazy
solutions like a RAM disk that are using other file system technologies actually
make sense. Apparently, this is all Fsync causing problems. I am not deep enough
to know. I don't care. All I know is it sucks, and whenever I move to one of my
Linux machines, cloning, installing, and all those things feels so much better
than it does on a Mac right now. This is one of the many reasons I think we
should be moving away from file systems. They're a rat's nest full of weird
problems and assumptions that are platform specific, and something that works
great on your Ubuntu machine might run like [ __ ] on a Mac just because they
have some weird thing happening in the file system layer. Do you know what
doesn't have these problems? Node.js alerts. If all of the content here just
lived inside of memory inside of something else, you don't have to worry about
the weird implementation details of the file system on your [ __ ] computer.
Yeah, I I'm annoyed about all this. I hope someday someone fixes the problems
for macOS, but I I'm done with file systems. I almost put file systems in this
list. I know better. So, instead I put Dropbox for devs, cuz I'm stupid, and
it's basically what I had in mind anyways. I have a handful of different
machines that I'm using for building with agents right now. I have my Mac Mini
in my other room. I have another Mac Mini downstairs that's mostly just doing
like home automation [ __ ] I have a GMK Tech Box that should actually be
arriving today so I could set up a similar thing on Ubuntu instead and not deal
with Mac OS's [ __ ] and also have a little bit more RAM. I have so much hell
just managing the content of all of those machines. I can't tell you how many
times I spun up a work tree and forgot to pull the latest main and now it's
building on a stale base. I can't tell you how many times I didn't have the
right environment variables on one computer but I did on another. I can't tell
you how many times I didn't know where a project was on one machine cuz I
architected my directory with all my code different than somewhere else. I do my
best to clone things in the same places all of the time but I don't always
succeed. Do you know what I don't have this problem with? Dropbox. Because
Dropbox is one structure that exists on all of my machines that use it. On my
NAS that backs up all my Dropbox content, on my editor's computer that downloads
all of the video content for it, and on my laptop where I do all my graphics
work, the structure and the contents of all those folders is the same across all
of them. But Theo, we already have Git. You know how I feel about that. But more
importantly, how do you manage your Git repos without making another Git repo
and then dealing with submodule hell which no one's actually going to deal with.
Imagine you had your code folder, the folder where all your projects are on your
computer, and then you go spin up your Mac Mini and everything is there. It's
all there the same way it was. Your environment variables can sync totally fine.
You'll have to do some weird hacks around node modules because they're different
on different OS's and whatnot. But imagine you could just have your code folder
on all of your machines without actual effort. Nothing is built to do this right
right now and you have to build a lot of pieces. I actually started with a
project called FS2 meant to be file system two. But even that wasn't going to go
far enough for what I have in mind. My dream here would be that I have my code
folder structured one specific way with all the different sub folders and
whatnot. And then when I spin up an agent in the cloud or my Mac mini or
anything else, the contents are all there or at the very least the structure is
there and once you navigate to or try to explore, touch any of the files in a
given section of it, it will pull that part down in the moment at that time.
None of the existing solutions come close to what I have in mind here, which is
let me use the stuff I'm already using but take over this directory so new
things will appear in it automatically without additional effort. Tavion chat
touched on like a rough piece of what I'm imagining here, which is imagine
something like Google Drive or Dropbox having their own equivalent of a
.gitignore. And Robert in chat here said, "Dude, I've been dreaming of exactly
what I'm describing for so long, but you don't have the skills to make it
yourself." Have you proven that to yourself yet? Have you proven that the cool
models and agents and dev tools we have can't get you over the line here?
Because what matters to build something like this isn't necessarily your
capability or your knowledge. It's your token budget and your patience. If
you're patient enough to go through the hard parts to do this right, Robert, you
can absolutely do it. And I really hope multiple people in my audience go and
try to do this. So, what is next on my list? We have to get a ramp down a bit,
right? Right? With a a new mobile platform? Huh. This one hurts for me to even
share. But I'm scared if we don't do this now, we'll never be able. A lot of
people don't know this, but I used to be an Android fanboy. I was like the
Android guy in my high school. I used to give people [ __ ] for using iPhones
when I was a kid. Obviously, uh that has since changed. I got the sinful orange
iPhone now. But I am what I am and what I am is a person who likes good
experiences on their devices and I'm a person who uses their phone heavily
enough and relies on it often enough and having a phone that works and works
well with all the applications I rely on is important. But there are things that
I can't stop thinking about when I think about mobile. Things like Apple's inane
god-awful policies about what's allowed to be distributed and paid for on the
App Store. The fact that I can use my credit card to order an Uber or a
DoorDash, but I can't use it to buy a game unless I do it through Apple Pay
because Apple's arbitrarily restricted digital goods is something they get 30%
off and has to go through their payment systems. The fact that they are banning
all sorts of [ __ ] just because they don't like it. The fact that the newest
Xbox release isn't allowed on the App Store and if you want it, you have to get
it set up yourself manually with a an account that you're paying 100 bucks a
year for and then have to spend hours setting it up. Or here's a silly one
that's one of my favorites. The Info.plist file that describes your application
and its permissions needs to have the developer in the team in the file, which
means your source control has one user's config hardcoded in it. It's insane.
The developer experience for iOS is so horrible that I can't imagine anything
worse until I try building an Android app. Android makes it a little easier to
start building and get it on your phone. But the chaos of getting it actually
distributed on the Play Store and the absurd opaque nature of when they decide
to ban your [ __ ] At least Apple gives you a admittedly [ __ ] reason why
they're not letting you release. Google just arbitrarily says nope, no release
and doesn't give you enough info to fix. Both of these are terrible. And I
forget how bad it is until somebody on my team asks me for my home address so
they can put it into the filing to get approval so they can start building the
app again. It's so bad. I'm going to tell a real crazy anecdote here and
somebody touched on it in chat. I'm going to talk about CyanogenMod a bit. Most
of you guys are probably too young to have any idea what CyanogenMod was.
Cyanogen Mod was a custom build of Android. Android is the operating system on
the majority of mobile phones, but it's also an open-source OS and platform. And
most phone manufacturers add a bunch of junk that most people probably wouldn't
want. Cyanogen Mod was a community effort to make Android better. It was meant
to be vanilla Android with a couple niceties and things like the ability to more
easily overclock your system, change your status bar colors, get rid of
bloatware, make your phone faster. You could even install custom modded kernels
and [ __ ] It was so fun. And I was really involved in Cyanogen Mod back in the
day. And here is where I will drop my spiciest take about where mobile was when
I was a kid. The reason I got so into Cyanogen Mod and customizing and writing
code for the OS itself is because, as stupid as this is, customizing Android
itself was easier than building an app. What the [ __ ] Imagine a world where
it's easier to fork Chrome and build new features in it than it is to put up a
website. Do you know how insane that would be? Can you fathom a world where
building a browser and editing your browser is easier than getting something
online? That was the case when I grew up on Android. If you had one of the
phones that could be easily rooted or have its bootloader unlocked or one of the
ones that somebody discovered the right way to do that with, flashing a new OS
was so easy and building your own was relatively trivial. I remember the era
where there were like 20 different flavors of custom Android ROMs being made by
independent devs doing it for fun. Ready for a real trippy one? Very few people
here have heard about Paranoid Android, I'm sure. Not the song by Radiohead, the
custom ROM. Drop ones in chat if you ever heard about Paranoid Android before.
More ones than I expected. Now drop a two in chat if you know the person who
made it. I don't think any of you guys do cuz this one blows me away every time
I learn it. Paranoid Android was founded by Paul Henschel. Paul Henschel's also
known as 0xCA0A. The creator of Poimanders. The creator of Zustand. The creator
of React three fiber. >> [snorts] >> One of the best React community devs in the
world started with open source ROM hack design and development. I ran an
operating system this guy created before I installed a package that he created.
And here is my spiciest take. Paul would have become a mobile dev if mobile dev
didn't [ __ ] suck. I haven't talked with him about this in depth, but if he's
anything like me and having talked to him before, I'm pretty sure he is. He made
Paranoid Android because he wanted to build things on his phone and building
apps sucked. Other ROMs pissed him off, so he built his own and it went really
well. And then he kept trying to build apps and other things and it still
sucked. And he found the web sucked less, so he went there instead. And Android
lost one of the greatest developers I've ever met because the platform was too
hard to build for. It was easier to rebuild the platform than it was to build
apps for the platform. And now we have to do one more rabbit hole here. I
promise this one's worth it. We need to talk about BlackBerry for a second.
BlackBerry was the first winner of the smartphone wars and it has since died
hard and been bought by TCL, the panel company in China, in order to experiment
with mobile screen development. The reason I want to talk about BlackBerry is
BlackBerry 10. Fun fact, I worked at Staples as a salesperson and technician
when the BlackBerry phones using BlackBerry 10 came out and it was very hard to
explain it to people because it was a BlackBerry, it ran their own proprietary
BlackBerry OS, but it could also run Android apps. They had a complete Android
runtime built in for running Android applications. This was a huge deal because
it meant that the incredible ecosystem of apps that were available on Android
would work on your BlackBerry even though there wasn't much software available
specifically for BlackBerry. You had BlackBerry special apps which were really
good at the time, but you also had Android's ecosystem, too. And that combo made
it seem really enticing, but there were some problems here. First off, there
just wasn't much reason to go with this instead of an Android phone, especially
because the Android apps performed a bit worse. The CPUs available for phones
weren't as good, either. So, the virtualization through the runtime was at
higher cost than it would hypothetically be today if someone did something
similar. And then there's just the fact that BlackBerry itself kind of sucked
and the software that they built was closed source and only ran on BlackBerry
devices, and it didn't offer anything new. So, why am I talking about BlackBerry
now? Well, I'm talking about it because they proved you can build a different OS
and still support Android apps. So, the historic problem that existed in
building a new mobile operating system, which is that you would lose the whole
ecosystem, I'm not one to pretend Android apps are just as good as the iOS
equivalents. Believe me, I know. I have a folding phone. I've experienced just
how bad Android can get, but I still need a place to put apps. And the fact that
it is so much work to even try to distribute an app other people can use is
insane right now. And what I'm imagining, what I'm dreaming of, is a future
where we do something similar to what we did in the Paranoid Android and
CyanogenMod era, the peak of custom OSs before we got to the era of LineageOS
where we're just trying to maintain a good minimal private open fork. I want
something experimental. I want something that works with Android and Android
apps, but is something fundamentally different. Something that encourages people
to build on the platform. Something that makes it easy to customize and
experiment and build new apps that can do new things. Something that makes it
easy for me to see something someone is demoing, scan a QR code, and have it on
my device working. Something like NPM, but for mobile. But to do that, you need
to go to the OS. And I think now might be the time to do that. In fact, I think
now might be the last time to do that as Android is getting more and more
closed. What would it look like to have a mobile OS that encouraged you to
develop on it, to customize it, to build whatever you want, both as a developer
and as a user? Imagine where you had access to all the apps you rely on every
day, but also a platform where you could build new things on top. Imagine an app
ecosystem that encourages you to fork and modify within the apps themselves. An
app ecosystem that doesn't block you from doing just-in-time compilation, that
lets you do crazy [ __ ] Ready for the hottest take? We already know what this
looks like. It looks like the internet. It looks like Linux. It looks like
Windows and macOS to an extent. And it looks a lot more open and a lot more
progressive than what we have on mobile right now. I dream of a world where
mobile feels accessible to do cool things on. And I'm scared we might never see
that world because we have a duopoly of people who just don't care. Apple
benefits too greatly from their 30% cut to ever make software distribution
easier. Android benefits greatly from having basically no money put into it by
Google at all and just slowly languishing and dying. So, the likelihood Google
does anything that Apple isn't doing first is near zero. It was a joke on the
Android team back in the day that the best way to get your good ideas to
actually ship an Android was to leak them to Apple, so Apple would add them, and
then suddenly Google would give you permission to do it. Android's kind of
become a [ __ ] joke, and that sucks because it shouldn't be. It's an open
platform. And thankfully, there are still enough devices shipping with open
bootloaders that you have a real chance to do something better. What would it
look like to rethink the mobile platform to support Android but to be something
else? I don't know and I'm scared that I never will get to. So, hopefully
somebody here will be inspired enough to go do it yourself because now is the
chance. Now is the last time. Speaking of things where we might have our last
chance right now, I want to complain about Slack a bunch. Oh, Slack. Slack has a
real lock-in problem that's going to be really hard to defeat because Slack's
connection system where I can have a shared channel between two companies is
really powerful. And almost every channel I have in Slack right now is just
there so I can talk to another company. But there are so many problems in Slack
right now that it feels miserable to use. The lack of inline replies is absurd.
You have to do a thread to reply. Threads themselves are pretty bad, too,
because they just fall back in the history even if they're still active and
finding them's even harder as a result. I can't reply to one message inside of a
thread. I have to reply in the thread and maybe manually quote parts myself.
Don't get me started on the code blocks and [ __ ] But then we have a new user
of Slack where it doesn't work really at all for them. Agents. We have been
trying to brute force agents into Slack for a long time and all it has done, at
least in my case, is remind me just how bad of a platform Slack itself is. Slack
is built for sending messages, nothing else. It is not meant for reading
messages. It's not meant for prioritizing work. It's not meant for getting
status updates. It's not meant for using. It's meant for sending. And I dream of
a world where that is not the case. I dream of a world where I have a chat app
that helps me prioritize what I'm supposed to be doing. That brings up recent
things even if they're happening in an old thread. That makes it easier to
branch off context, take a sub comment, and send an agent to go explore and then
come back with feedback. I want infinite nesting. I want threads that make
sense. I want replies that make sense. I want agents to be able to come in and
be part of the same control plane I'm in in a way that is logical. And what I
want, and this hurts me, this really hurts me, I want Facebook workplaces. We've
all used Facebook at some point. When you make a post on Facebook, it's now
there. It could be in a group, it could be on your wall, it could be a lot of
different places. You can post on somebody else's wall even. Once that post is
there, you can leave top-level comments for things you want to respond to on the
immediate post, but you can also nest comments. You can do threading within a
given comment on a post on Facebook. You can sub-nest within that, too, where if
one person leaves a comment saying, "Hey, I'm not sure about this." And then two
people reply with different takes, you can reply to both of them individually
without it clogging up the main thread. And most importantly, when someone
leaves a comment on an old post, that post gets brought to the top. Why the [ __
] don't threads work that way in anything else? Why is it that when there's an
old thread and I leave a reply in it, the thread stays old unless you haven't
have notifications on for it in literally every other app? Facebook workplaces
is the closest thing I've ever seen to a good context management project and
product for working with a team on real work. Posts were much better primitive
than Slack messages. The problem is that we have a weird breakdown with chats
right now between messages, replies, threads, channels, and companies. And none
of those are the right abstraction, and we're stuck fighting them all of the
time. I think posts are much better primitive because they fit somewhere between
something like a channel and something like a thread. And then threads are the
sub-primitive on a post that makes them very easy to interface with. And not
just for humans, for agents, too. So, why don't I just use Facebook Workplace?
It's cuz they shut it down 2 weeks ago. The one platform that could have done
what I wanted doesn't even care enough to keep iterating. They announced that
they were ending all development in August of last year. I want this so bad. I
want this so bad. I even started building this one myself, but I've been too
busy to go anywhere with it. I want something like Slack that feels more like
Facebook that is built to be way easier to interface with agents as well. Now,
imagine combining this with something like Hermes Agent, where instead of having
a bunch of threads spun up inside of Discord that are impossible to manage,
still better than doing it in [ __ ] Telegram, by the way. Instead of that, you
have an actual content system. You'll have a group where you post the things you
want to work on, and then when your agent replies to the post, it gets bumped
back up to the top. So good. And I wish it existed. Apparently, Teams has some
of these ideas baked in somewhere, which is cool, but it's also Microsoft Teams,
so it'll never be useful. Let's be real. I want this as an open-source standard
that is easy to adopt and play with, not to replace Slack, but to slowly replace
Slack. I have one last thing I have to talk about, and I'll keep this one short.
Benchmarks. We need more benchmarks. We need weird benchmarks. We need
benchmarks that are written by people other than researchers and labs, because
we need better ways to measure the capabilities of models. It's silly, but my
stupid SkateBench, the benchmark where I measure how well models can name a
trick given a description of a skateboard trick, has turned out to be really
useful, and a number of researchers and labs have hit me up asking questions
because the numbers fascinate them, because it's somewhere between a complex
grammar bench, a niche English like language bench, and a 3D spatial reasoning
bench. And we need more benchmarks. We need people to take the work that they
try to use AI for that fails and save it in a reproducible way so they can try
it again. We need benchmarks that measure how good agents are at stuff like Git,
which CM Griffin just made Git bench, which I'm really excited about. We need
benchmarks that measure everything from weird hypotheses to real work and
everything between as well. We need benchmarks that measure how well models can
determine what a picture from the sky is of. We need benchmarks that can
determine which models are best at diagnosing cancer given random screenshots of
like random scans that people had done with MRI machines. We need more ways to
measure the capabilities of models. We need a lot more of them and we just don't
have enough. Go build some weird benchmarks, especially if you have a problem
that agents suck at. Building a benchmark that shows that all agents suck at it
is one of the best ways to incentivize the labs to fix it. If you really love an
obscure programming language like Crystal or something and you notice that the
model suck at it, make a bench that measures it to show the world and to show
the researchers that models are bad at that language. As soon as there's a way
they can measure it, they'll go hard to try and ramp up their scores. Go build
some benchmarks. You'll be surprised how much you learn and also how valuable
those measurements can be. I think I've covered all the random ideas that I
really want to will into existence here. I just want these things to happen and
I will give you guys the warning in advance. If you do build one of these
things, the chances that I try yours are relatively low. But if you make it
successfully enough that I see others using it, that I see my team using it,
that I see people talking about it and posting it, I will absolutely hop in to
give it a look myself. I want these things to exist way more than I want to
build them and I'm hoping someone else will step up and build a handful of them,
even just to push software forward as we challenge more of our existing
assumptions about how things are supposed to work. It's time to build bigger
stuff and I hope this helps give you some ideas on cool things to build and if
you have your own different ones, you should go do that instead. The point here
is to try and push you to build bigger solutions to harder problems than would
have made sense before. So, what are you waiting for? Go kick up an agent and
try one of these things out. See what you can build. I bet you'll be surprised
just how far you can go. I know I have been myself. Go experiment. Go build. Go
challenge things that you didn't think were possible. Go boil the ocean. It's a
really fun experience to do. Let me know how it goes and until next time, peace
nerds.
