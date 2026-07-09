So, you've decided it's time to move on from GitHub. A lot of people have.
Myself, Mitchell, the creator of Ghosty, and many other people are realizing
that GitHub might not be the safest place for us to be leaving our code now that
they're randomly reverting merges and having downtime that is measured in days
instead of minutes. We're in a tough spot. So, what are our options? There's
tons of alternatives, right? Like GitLab, Bitbucket, Dropbox, Git, Forge, Joe,
Codehub, or sorry, Codeberg. So many options, right? I grabbed as many as I
could find, and there are a lot, but I have feelings about most of them. And the
bad news is, as great as many of them are, I'm not sure if any of them are quite
ready to be a proper GitHub alternative. And even if some of them are ready, the
effect this will have on the open source community is tough. I'm going do my
best to break down all of the options you should consider, figure out what you
should actually move to, if you should move at all, and where things are going
to be long term. But if I'm not going to be making money off GitHub sponsors
anymore, we're going to have to take a break for a normal sponsor. Agent coding
gets you pretty far, but there are some things that it just can't do. In fact,
there are certain things it makes harder. If you have an agent that's able to
browse the web, how do you know that agent is the right person? If you're using
an agent to use MCP, how do you know that it has the permissions that it's
supposed to have? And if you have a user coming to your site, how do you know
it's actually them? You can probably try and vibe code this all out, but you're
better off using today's sponsor, Work OS. These guys get off and they get it at
all levels. If you're a small startup or a big company or even just a side
project, work OS has you covered for free for your first million users. You're
probably already familiar with their login components because they're used by
everyone from OpenAI to Enthropic to Cursor to T3 Chat. Basically everything is
using work OS now. And there's a reason. They understand what we need as
developers trying to build off that is business ready. If a Fortune 500 company
hit you up right now and said, "Hey, do you have ADP working? We would love to
start a contract with you guys in the next 2 weeks. Do you have that stuff
working? Do you know how to handle the sample compliance and all the other weird
crap you're going to need to do to get that business onboarded? I certainly
don't. I've had to try in the past and it was not fun. With work OS, you just
send them a link to the admin portal. That's it. It's so simple. Engine sales
shouldn't be blocked on off. Start selling better and shipping more at
soyv.link/workos. There's a couple angles we can go here. I could go through
each option individually and explain what's good, bad, and ugly about it, but I
want to do a couple other things. First, I want to establish what are we
actually looking for. I'm going to start by listing things GitHub already does
and arguably does well. First and foremost, place to host Git. I want a
serverbacked Git remote that will hold my code that lets me and others work on
it at the same time. Part of that is implying a PR workflow, some way for other
people to contribute their changes and a system for merging those changes. Along
with that, one of the cool aspects is a community. Be it whether this is
profiles, histories, a feed that shows cool stuff, people are doing, stars, all
of that type of thing. I think this is one of the coolest parts about GitHub.
So, I would like to see this in alternatives. One other piece that I think is
pretty important is CI and CD. You know, this probably is GitHub actions. A lot
of these alternatives have their own solutions. Some don't. It is important.
Here's where I'm going to draw a line for things that aren't part of GitHub, but
would be really nice to see. Things like stable platform. Be really nice if we
don't have to worry about it going down all the time. Things like open source,
so if you need to host it yourself, you can. Then we'll do a very vague AI
native piece here. We'll get to this in a little bit. Don't worry. So with these
things established as what we are roughly speaking looking for. Let's start
looking at the options that we have. We will start with GitLab. GitLab is the
option that most people are referencing, thinking about and citing. GitLab has
always seemed to be one of the best options. I want to think of a good analogy
for this. GitLab kind of feels like a bicycle. Makes a lot of sense. A lot of
people consider it an option, but everybody just kind of chooses to walk, Uber,
or buy a car. We all know we could bike more, but we don't. And the few people
who do will tell you in detail all of the things that make biking suck terribly.
There is no better way to be convinced to not bike to work than to talk to
somebody who bikes to work. I didn't realize how bad things were because I, like
most people, thought a bicycle was probably a good idea, but just didn't bother.
Now I'm seeing people who actually use GitLab and they have a lot to say. Josh
here has disagreed with me many times in the past. He's we've come around to
each other over time and he had a lot to say about GitLab. GitLab was designed
by developers with no eye for design, but think they do. The UX is atrocious as
if they never use their own product. I'd let GitHub lose another 5 to 10% uptime
before I consider switching to Bitbucket before I would consider switching to
GitLab. And don't worry, we'll have plenty to say about Bitbucket, too. But
first, we have a beautifully egregious example of terrible loading behaviors.
This one was great. He had this page here that has these repos. He clicks one of
the repos. It brings him there. Well, it's an org. He goes back and now they're
not loading cuz that was hidden under a second loading layer. That is so bad.
That is so bad that like navigating back and forth causes content to disappear.
We already have the problem where whenever I'm on GitHub, I assume I have to
refresh to see what's going on because otherwise I might just lose all of the
content. I fear that constantly when I'm navigating GitHub. GitLab appears to be
even worse about that where you can navigate back and forth and have things
disappear because they don't refire the API request that they're doing. And
that's just the start of it. Jason Cox here broke down significantly more
problems that you will see on GitLab. Key frame this as UX monstrosities that
make it unusable as a drop in replacement for GitHub. So let's look at the
GitLab project itself for these examples. You land on this page. You're honest
with yourself. Your reaction should be, "What the [ __ ] am I looking at?
Where's the read me that tells me what I'm looking at?" The answer is that
you've scrolled down the page 75%. Yeah, there's the readme. They did make a
change where they put more info up the top here specifically because they got
flamed on Twitter for this, but it it's Twitter driven design changes. This is a
really good point as well. Somehow all of these numbers have the same weight.
Does this make sense to you or did you come here looking for releases like
everyone else does? Yeah. The reason I look at this section on the side is so I
can go to releases quickly. That is not easy to see because there's all of these
different things that are the same weight. How often are you clicking tags or
environments and looking through them? This is awful. Now, let's click on
history because I want to find some commit that was made last year. Where do I
find this? You get infinite scroll. Nope. Search my message. Don't recall the
commit message. Author. I can't remember who authored it. Browse files. How do I
filter by date? Yeah, here we are in commits. We can very, very slowly infinite
scroll. Waiting. Waiting. Okay, there's another chunk. So, we want to find a
commit last year. Good luck. Your best option is to just clone it because you're
not going to find it. Back to releases. Let's take a look at the release page.
This is what he sees and he has a ton of questions. When was this released? What
does 88% complete mean? And was this actually released? Or is it just a random
like, oh, it's 89% released? What What does this even mean? If I'm here to
download something, what is there other releases? How hard to scroll? Oh, GitLab
1810 is 94% complete. What does that mean? 189 96% complete even though it's a
historical release. No info, no date. Oh, the date is here all the way at the
bottom after you scroll through the whole change log. The data that's useful is
at the bottom, not the top. At the top, you get these things that are useless to
most people. That's really bad. And if you click the commit hash at the bottom,
let's click it. That one was the update to the version file. That makes sense.
What about the most recent releases? That was also the version file update. That
makes sense. What's he complaining about here? Oh, it's the same one. Cool.
That's the commit that updated the version. But I want more of what happened
here. How do I get that? Can I see what else went into this release? Can I click
something to see all the commits that are between this and the previous one? Can
I get more info anywhere here? This is a really bad view and releases are a very
important view. Getting these this bad is scary. Now I want to see what changed
immediately after because something is breaking right after the release tag and
I can't. There is no next commit button. Why? There's a parent commit. You just
can't go the other direction. Yeah. Yeah, I can go to the parent, but I can't go
down. Even though this is on main or a release branch. And what's this? Branches
with an arrow here. Oh god, that scroll broke a ton of [ __ ] There's the arrow
and then branches containing commit. Is this going to navigate me or is this
going to open there? Okay, that was hilarious. It did the slide to open and then
hung and then pulled after. Like, I'm not trying to be nitpicky here, but I'm
going to nitpick cuz this is not something I would actually enjoy using at all.
This is impossible to navigate. Like what? And you might think like, yeah, it's
mostly open source though. Can't you fix these things? How big do you think the
GitLab code bases? Do you throwing out some fun numbers? 200K, 250K, 1.6
million. Well, considering that the clone isn't even starting to show me the
data for the clone after I accepted the signature here. Got a bad feeling about
this one. I'm trying. How long is it going to take to clone GitLab from GitLab?
It's an open- source repo. It shouldn't matter that I don't have the SSH key.
It's not The SSH key should authenticate who can download that code. Yeah, see
it is going. It just took that long. It took 5 minutes almost to start
enumerating what it's going to clone. We have 7,59,000 Git objects. This is
going to be bad. It is about 5 megabits per second faster to clone from GitLab
than it is from GitHub. Let's clock it. It is 12,78,69 lines of code. What the [
__ ] a P 0 file? Okay, that seems to be about 4 mil of it. The rest is 3.8 8
million lines of Ruby, 1.16 million lines of JavaScript, not TypeScript,
JavaScript, another mill of Markdown, another mill of JSON, 600K of Vue
components, 490K of YAML, almost 90k of just raw SQL, a tiny bit of Go, a
shitload of GraphQL. You you get the idea. You're not vibe coding your way out
of the issues here. And apparently, it's Vue 2. It's not even Vue 3. This is an
old ass project is the point I'm trying to make. GitLab as a more open
alternative to GitHub makes sense in the same way that Azure as an alternative
to AWS makes sense. It is similar but just worse in every single way except for
uptime. But there is no other benefit to GitLab. I have heard their CI is a
little bit more pleasant, that their equivalent of actions is a little nicer to
work with allegedly. I haven't confirmed that myself, but GitLab is just a worse
version of GitHub the same way Azure is just a worse version of AWS. If you're
okay with that, cool. Maybe you can go use GitLab. But the like harsh reality is
that it's just not that great. Like I've tried it many times before in the past
cuz I love the idea of a GitHub alternative that I could host myself and use how
I want. And in reality, it just hasn't worked out that way. This is a project
with 528,000 commits. That is almost half a million commits. This is an old ass
project. And a point I'm going to make, and this is going to come out a lot,
generations of product. For an example we can all relate to, I would argue that
Sublime Text was the first of a new generation of text editor where it
introduced the idea of a minimal text editor that you would extend to have your
needs rather than an IDE that came with all the features included. Sublime Text
was really good, really cool, awesome. Atom came out, which was a downgrade in
many ways, but the accessibility was better and it was open source. And then
Microsoft saw the writing on the wall and made VS Code taking all of those
lessons. I would argue VS Code is one of the best versions of that generation of
product. And then we had cursor which was trying to improve that generation of
product using AI. But there's a pretty clear path in my opinion from Sublime to
Atom to VS Code to Cursor. And I would argue all of these are the same
generation. And the previous generation would be things like Visual Studio,
things like Eclipse, Jet Brains, all those types of tools are the previous
generation of developer experiences, developer environments. Sublime kickstarted
the nextG. Sublime was the worst version of the next generation. Cursor was in
many ways the best version of that same generation. But now we have had another
generational shift. We're moving towards different methods and user experiences
for coding entirely. We're moving into things like cursors glass view or T3 code
or the codeex app stuff like that where T3 code means I'm using VS Code a lot
less and it feels fundamentally different but it is a new generation of product
and I would argue things like T3 code are like Sublime where they are entirely
different from how we did things before and they are in many ways the worst it
will ever be. The real sublime for this would have been composer. Composer was
the first like, oh [ __ ] this is a better way to think about your parallel
agents and we got the awful anti-gravity thing, the anti-gravity agent manager.
Then I would argue the next big one that matter was codeex app. And now I'm
hoping fingers crossed that T3 code can become the big winner similar to VS Code
and cursor. You get the idea though. There's generations with these products.
And if you compare Sublime with VS Code, yeah, Sublime was a little bit faster
and cool, but VS Code is obviously better once you see how powerful it and its
extension ecosystem are. You can't compare so cleanly between Sublime and T3
Code because they're from different generations. T3 Code is a lot worse than
Sublime in many ways, especially if you're just trying to read code. But T3 Code
is an entirely different way of thinking. It's a Gen 3 in this example. Before
GitHub, we had solutions for source control. We had platforms for managing SVN.
We had Fabricator. We had all these other things. GitHub was the first one that
was good enough to like start a new generation of products. And when this
generation started, a lot of people tried to build their alternatives. One of
those, one of the successful ones I would argue, was GitLab. There is also
Bitbucket. These are all, in my opinion, the gen two of version control and
centralized source control. We had the old solutions before. We now have these.
These are all part of the gen two so to speak of source control. So what is gen
3? We'll get there later. Maybe we'll see. But for now, I want to emphasize the
point that GitLab and Bitbucket aren't generational improvements. They're not
trying to be very different. The same way that VS Code wasn't trying to be very
different from Atom. It was just trying to be better. And a lot of why VS Code
won is because Adam was so [ __ ] VS Code made a lot of sense. and Sublime being
closed source and not really embracing the extension ecosystem meant it wasn't
as powerful for the use cases we wanted to use these things for. So again, VS
Code didn't win by adding all these crazy new features and things. They won by
being the best option in that generation. The harsh reality that we're likely
going to come to is that GitHub, as shitty and unreliable as it is, is in most
ways the best option of this generation where you have things like AWS, GCP, and
Azure. And now we have things like railway versel and convex. That is a
generational shift in how we think about interfaces, how we think about these
infrastructures, all of these things. Okay. Now that we've established the idea
of generational solutions, GitHub was probably the best of this generation, but
we should explore the others. I would argue GitLab's value wasn't that it was
better than GitHub, is that it was an open alternative to GitHub that would
often price itself cheaper for enterprise deals and the enterprises would have
more control over what they were using it for and hosting it with. So GitLab was
attractive to a lot of enterprises enough so they could make serious money. Like
last year, GitLab did almost a billion dollars in revenue, which is 26% growth
over 2024. They're making money, and they're making that money by licensing to
enterprises. But as we've now established, product is not great to use. So let's
move on to Bitbucket. I like the phrasing here when you Google search Bitbucket.
Git solutions for teams using Jira. Hopefully I don't need to go much further
here, but we'll look at Bitbucket versus GitHub according to Atlassian. First
thing, code and CI up to 10x savings. They are not trying to push this as a
better solution. They're trying to push this as a cheaper solution with
best-in-class Jira integrations. First, look at how much cheaper it is per user
than GitHub Enterprise Cloud. Wow. And then they show how numbers multiply when
you increase the other number you're multiplying it by. Crazy. When number goes
up, number goes up. This chart should tell you everything you need to see about
why this is not the solution for you. If you're pricing your source control and
the engineers that have access to it and you're this excited to save $15 a month
on engineers, you're probably not paying your engineers very well and I'm
generally not that interested in you and what you're doing. If you're going that
out of your way to save $15 per month perge, I don't want to work at your
company. Oh, even better. The 10X savings is based on the GitHub plan priced at
$21 a user plus the $50 per user security add-on plus the premium support
add-on. So they intentionally added all the custom features on GitHub in order
to make the price look as egregious as possible. Let's keep going. Dev Sec Ops
tools are included. Secret scanning, dependency scanning, and infrastructure as
code scanning tools for no additional cost. GitHub charges for security tools as
an add-on. Premium supports included too. Premium support in 99.9% SLAs's. Okay,
this part actually probably is useful. The fact that it's actually up. Cool.
There's the first actual useful thing. Flexible build minute plans. Get started
with 3500 build minutes per month and buy additional minutes based on your
usage. Note that that's not per user. Every account gets the 3500 build minutes
once you create your organization and then you have to spend more. There's a
reason there's a lot of other cool things happening in CI. I don't know who's
sponsoring this video yet, but there's a good chance it's one of our bigger
sponsors in the space like Depot or Blacksmith. And they're both awesome
alternatives to running CI on GitHub or Bitbucket. They're cheaper and faster.
Highly recommend. So, why would you choose Bitbucket Cloud over GitHub? First,
because it simplifies your tool chain. Put your code and CI/CD on one platform
with Jira and capabilities spanning the entire software development life cycle.
Reduce context switching. Developers can view and manage issues with a built-in
Jira UI. I'm going to do a quick test. What do you think comes up more on this
page, Git or Jira? Jira's on the page five times. Okay, Git is there more. It's
there 13 times. How about code? Okay, code's there 12. Cool. So, Jira is
mentioned at least five times on the page. Pretty hilarious. Not as many as
expected, but it feels like it's everywhere. More Jira mentions. You can keep
operation teams in sync with a native integration into Jira service management.
JSM. All commits flow into JSM and automatically kick off upon approval. Native
IDP experience. You might notice a pattern here. The value you get out of
Bitbucket is if you're already a big customer of Atlassian, it integrates with
your other Atlassian stuff. That's it. That's the value you get. They have 15
million devs on Bitbucket and they only could get three quotes. And it's an
analytics company. Nexttiva and Flow are the only companies with anything to
say. Thankfully, Bitbucket is very willing to disqualify themselves. They're
back to our options list because we've largely ruled out GitLab. If you care
about user experience, it is just worse GitHub with slightly better uptime. And
we have Bitbucket, which is Bitbucket. So, how about we look over here where we
get some of the open options. You're curious what the separation was here. First
section was the more enterprisey business options. GitLab does have open source
stuff, so it's a weird in between there, but they are very much an enterprise
that makes a lot of money. Everything here is for the most part known for being
open- source or nonprofit. So, I'll start with Git T. Gee is honestly the one
that feels like it comes up the most, mostly as an open alternative to GitHub.
But you might be noticing something. Nothing here says open. Git T is a private,
fast, reliable DevOps platform. Self-hosted DevOps platform that gives teams and
developers high efficiency, easy to run operations from planning to production.
Quotes from people. Best open- source and self-hosting platform for version
control is gi platform. Notice none of these people even have pro pictures. I
actually know Satchin. His account doesn't exist anymore. Great. How many of
these exist anymore? Also, the names are all the same format. Not suspicious at
all. Yeah, a zero following account. Great source. They do have free
self-hosting under the MIT licensed version, which is a different version, and
then an enterprise plan for $9.5 a month instead of the usual 19 if you do a
one-year commitment. Notice they keep calling it private, fast, and reliable,
not open. That's because they kind of rug pulled. A lot of people are very mad
at Git and not just because like they have weird hover treatments all over their
site and because they're jank as [ __ ] and kind of false advertising here with
these quotes that can't actually be traced back to the original people who
posted them because those aren't real accounts. All of that aside, the problem
with Git is that they were very open before. The people running it decided they
wanted to go more private and charge for it. The community felt rugpulled and
they forked. So, what happened to the Git T community is that they forked and
the fork is Forge Joe. Forge Joe is a self-hostable lightweight software Forge.
It's easy to install and low maintenance. It just does the job. They formed the
Codeberg EV, which is democratic nonprofit or that maintains Forge Joe. You can
create an account on Codeberg and other instances or download it to self-host on
your own. I want to be really kind to these guys because it is so important this
exists and I genuinely think it's awesome. If you want to just find a good
enough alternative to GitHub to like not have to worry about and use it and get
back to work, go use Forge Joe. They're awesome. I love that this exists. I love
the way they formed it. I love that it's a truly free software organization
formed by a democratic nonprofit. This is the right way to build open, reliable
software. Massive respect to Forge Joe and Codeberg. Wanted to get that out of
the way first because I want to also try using it and I have feelings already. I
actually went and made an account because I do really want to try it. And after
signing up, this is the view I opened it to. My face isn't covering anything
valuable here. This is just where it opens. Generally speaking, free software,
foundation style software, things that are are free as in free press software,
not going to be the best designed stuff. And then when I refresh, you'll see
some questionable loading states here with the search, even though I haven't
done a search. And it's still spinning. It spins for like five plus seconds.
Well, let's explore some repos. Oh, I'm hitting a capture check. And now we have
the actual Forgejo repo. Reminder, that's what this is built on. Codeberg is the
product that you can use to use Forgejo in the cloud without having to set it up
yourself. Forge Joe itself actually looks pretty well maintained and solid.
Hasn't been going anywhere near as long as GitLab has. Way fewer commits, 25K
instead of the 500,000 we saw before. But also, you can see the size of the
community difference where the source code that Codeberg is hosted with, Forge
Joe, has 4,000 stars. It now has 4.3K and one extra because I hit it on my new
account. Let's take a look at the codebase. I'm actually curious. Way smaller
and more elegant. The whole thing is like 12 megs. Oh, they're on the latest
version of Node. That's also a very good sign. All All very green flags so far.
Like I I'm not upset. Let's analyze it, though, because I can't help myself. You
guys know how I am. Way smaller, actually. Damn. 400k lines of go, bunch of INI
files, small amount of JavaScript, small amount of TypeScript, some Vue. That is
very reasonable for what it is. And since it's a Go project, it's going to run
much faster than a lot of these alternatives that are Ruby based. Yes, both
GitLab and GitHub are built on top of [ __ ] Ruby, which is a huge part of why
they're hard to scale. I also There's a lot of little things in the UI here I
love. like it's not pretty, but releases is right up here as a top level thing.
That's great. And if I click it, oh, this is exactly the info I need. We have
when it happened, how many commits were involved in this release, and I can
click this, and it is a bit slow to load this because this is a big project on
the free hosting on Codeberg. And now we have all the commits for this release.
It's ugly as sin, but it's doing exactly what I need it to do. There's
apparently themes. Oh, yeah. Codeberg dark. You have to click change theme
after. Didn't appear to change anything. Okay. So, it's the Forge Joe dark.
Okay. Yeah, I like these colors a lot more. Actually, this is a little egregious
in terms of the customization, but it's cool. They offer these types of things
where you can pick types of comments that just won't be visible to you. That I
like. That is useful. But I'm just like the release tab is great. Like as good,
if not better than GitHubs. An actual search here. There's an RSS feed button,
so you can subscribe to the RSS feed for releases. This is a developers platform
for sure. This is built by and for devs, but like with a little bit of taste. I
thought I was going to hate this more. I'll be real. You probably have to scroll
too far. You have to scroll way too far to get to the read me. All of them make
this mistake sadly. They everybody puts the code first, which doesn't really
make sense and never has. But renderers read me is fine. I just can't get over
how good like this is. Like I can get to the things I need to get to really
quickly from here. How are the issues? This is like onetoone GitHub clone stuff,
but they load relatively quick. I expected to hate this more, guys. I really
did. Can you embed images or do they just get attached like this? That might be
killer if that is the case. If you can't like put an image in the body of an
issue, they do embed. Okay, they embed. That was just the way that was set up. I
guess that was the code review tab. This is where a lot of things start to break
down. It would be nice to get an idea of how big a change is from this view. Not
a lot of things do that and it's expensive to calculate it and like preserve
that this high up, but it would be nice to see how many lines of code were
changed in a given PR. It does show it here still as expected. Oh, there's a
little bit of jank in transitions, but like GitHub's code review is as if not
more jank. This is clearly like ripped off from the new GitHub code reviewer,
but it's solid. Oh, wait. This is the big one. Does split view require a page
reload? Cuz the GitHub one has for a long time. It does. It has a full page
reload when you switch from split view to the normal view. Not everything can be
perfect, but like this is absolutely passable. I I would pick this over GitLab
easily. Apparently, I'm pronouncing it wrong. I'm not going to fix that. I'm
sorry. They have a comparison with Git over in their FAQ. ORJ was created in
October of 2022 after a for-profit company took over the Git project. Exists
under the umbrella of the nonprofit organization Cobberg EV. It's developed in
the interest of the general public. In the years that followed, the difference
in governance led to choices that made Forgejo significantly and durably
different from Git T. You'll find below the most important reasons to choose
Forgejo. Exclusively free software like proper free Libra software and they also
test and release it using Forgejo actions. Pretty cool. Git T's actually
developed on GitHub and release the GitHub actions. I did not know that. That's
hilarious. Forge Joe's localization is done via weblate which is an open thing.
Git tease is crowded which I believe is not open. Four Joe's quicker to fix
security things. Apparently, Git T has been lazy about security stuff. I can't
verify that trivially myself, but I trust these guys. I have no reason to not.
There's a lot more effort into stability with Forge Joe and end to end testing
across it, which is really cool. You know what? I'm putting my money where my
mouth is. We're donating. They're not even at 300 a week. Gross. One moment.
Okay, just just more transparency stuff. This was unchecked initially. are
forced to check automatic or manual renewal. It doesn't just automatically
select one. You have to pick one. They are being really chill. I just threw them
1,200 bucks and they'll be getting 400 a month from me going forward. It's the
least I can do. This is a project that deserves support. I am actually very
impressed with what they have built here. And when I saw how little money they
are getting right now, it's insane. So yeah, least I can do. You got to put your
money where your mouth is and it is important to support projects like this. I
thought I was going to come in and be like, "Oh, this is ugly. This is slow.
This is useless." No, I could see myself using this. Like, legitimately, this is
actually gonna change my plans for this video. I like it so much more than
expected. I'm actually going to move some things over after stream and try this
out more myself. I'm impressed. Apparently, Forge Joe actions can largely use
the same YAML files as GitHub actions do. So, it's like a onetoone move. That
said, I don't do GitHub actions on GitHub. If I do them on other platforms, like
I mentioned before, Blacksmith and Depot, if I can link those up, which I almost
certainly can, I'll be very happy. And if I can't, I'll convince the two
companies to make that work. Good [ __ ] This is really good. I'm I'm hyped.
Yeah. Shout out to Forge Joe and Codeberg for all the work they are putting in
here. For those who haven't been paying attention, Forgejo is the actual source
code that is running this git backend for your remotes. and Codeberg is an
existing hosted version of it that is also the corporation which is a nonprofit
organization that owns and maintains Forgejo. This is a very good symbiotic good
to see relationship and the most important thing their actions have had some
downtime for the freeto use hosted version but their actual site and the source
control in Git has way better uptime than GitHub does right now. And what is the
partial degradation? Do they have info on what's going on with that? Ah, the
outage on actions was them preparing for copy fail, the Linux CVE that went live
a few days ago. But the transparency on this Mastadon account where they post
status updates is insane. I would kill for this level of transparency from
GitHub. I don't even fault them for that. If this is just because of [ __ ] copy
fail, that makes a lot of sense. But remember, you can just host it yourself. If
you have any issues with their hosting or you have things that are like
legitimately valuable and important that you want to have high enough uptime on,
you can just self-host. Oh, apparently you can bring your own machine on
Codeberg, too. You can just host your instance of it on your VPS and still be on
codeberg.org. Oh, it's just for actions. Oh, I thought it was for like the whole
instance for actions. That makes sense. Yeah. So, you can add your own runners
and register them yourself. That's pretty cool. I dig that. I like where they're
going with this. This is a legitimate option. And if you're looking for
something you can self-host, I would not [ __ ] touch the pile of ruby slop that
GitLab is. They're doing everything right here. I I am hyped on this. Yeah, this
this meaningfully changes the direction I was going to take the video and I'll
still cover the other piece I think are important. Source Hut. I I don't even
care anymore. Yeah. Yeah. I just looking at this. No, this is not for us. Hosted
real time chat services. I don't care anymore. Cool. So, Forge Joe and Codeberg
are the things that we like and recommend. Now, that was easy. Let's look at the
other stuff I have here, though, because it's all here for reasons. We got Code
Commit, which is largely dead. We got Pierre, who we'll come back to. We have
Google Code, who is largely dead. Google Code was originally not using Git
because Google firmly believed for a while that Git was the wrong solution. They
changed their minds. SourceForge [ __ ] show. Fabricator actually dead. But now
we have to go to this section at the bottom here. Graphite entire and Pierre and
Pierre in the literal immediate sense is dead. If you're not familiar, Pierre
was a GitHub alternative trying to rethink from first principles. And as they
say on their current homepage, development on this project is currently paused.
What seems like a really good time to have a GitHub alternative? Why' they pause
it? The reason is the two other things they're building, the primitives to make
a better GitHub. One of which I'm really hyped on is code.sto. And not just
because they have like the most beautiful site I've ever seen. They are really
crazy about their design [ __ ] The point of code storage, their new service,
code.sto, is that it lets you programmatically integrate git and push shitloads
of code really, really fastly. It's an ultra low latency git cloud for reading
and writing files from anywhere, bringing classic Git workflows like branches,
commits, and merge strategies, as well as novel concepts like ephemeral
branches, in-memory writes, cold storage, grap, and more directly into your
product. This is a new way of thinking about GitHosting built heavily around
this idea of agents pushing way more code. In GitHub's coverage of why they're
having so much downtime, they love citing these graphs, the massive increase in
the number of pull requests, commits, and new repos that GitHub is seeing
because agents are making more people do more projects and they can't handle the
throughput. That's because they're built on top of a pile of Ruby slop that
horizontally scales almost decently but barely and they are hitting the
limitations of the system that was built for multiple orders of magnitude less
traffic than they're getting. Pierre started from scratch with code storage with
the goal of making it handle super high throughput agentic style work. I would
argue that Pierre is building the foundation for this third generation of source
control. So if we were to do the Gen one, two, three thing, Gen one was SVN. Gen
two has the great enterprise option that is slowly dying of GitHub, but also the
phenomenal open-source solution with Forge Joe and Codeberg. So those are the
two options I would recommend for Gen 2 because Gen 3 is not even close to ready
yet. Nobody has built a proper Gen 3 product, but Pierre is the first company
building the pieces for it and code storage is one of those pieces. Pierre
stored 9 million repos in the last 30 days. Peak of 15,000 repos per minute for
three hours straight with no downtime. They built it for this throughput and
they are hitting this throughput. I happen to know cuz I'm friends with the team
their current numbers are even crazier than the numbers they posted in March and
they're handling it fine because they built it for this. Meanwhile, GitHub is
collapsing under 20 million new repos. They did half that and have no issues. So
again, my friends at GitHub, I'm sorry, your [ __ ] [ __ ] sucks. People are
asking, "How much do we trust the stat?" I'm friends with them. We trust the [
__ ] stat. To be clear, this is just the Git infrastructure. This isn't pull
requests or history management or issue tracking or release cycles or any of
that. This is just the git backing behind all of it. But everything here that
GitHub's complaining about other than PRs merged is from the git backing. The
git backing is apparently a problem according to GitHub. Otherwise, I wouldn't
put put this here. But here's the secret. The git backing is probably not
GitHub's problem. It's all the slop they built around it. But if we have a
really solid reliable git backing to start from, we can build not just
alternatives to GitHub, but alternative ways of building entirely. And like
there you go. TypeScript con store equals new git storage. Cons repo await
store.create repo. Do you know how much time and effort it takes for me to
commit a repo on GitHub? I crashed out about this in a video and people were mad
at me for it. So yeah, let's just I'll show you some fun examples. Let's do it.
Okay, let's say I want to push something on GitHub. Get status. I don't want to
add the P cache. We'll just do get add db.py. Let's put this on GitHub. GHPR
create can't. Okay. GH repo create. Oh, first option. Create a new repo on
github.com from scratch. Create a new repo on github.com from template or push
existing repo to GitHub. the obvious thing we want. Okay, I'm here. Enter. Path
to repo. Probably the thing I'm in right now. Repository name. Some random name.
Wait, I want to go back. I'm going to press option and delete, which I do all
the time for deleting things up to the last non like asy character or last non
letter or number character. Option delete. Oh, it crashed the CLI. I have to run
the whole thing again. Let's do it. Down arrow twice. Enter. Enter. Some other
name. Enter. Wait. Loading time because it has to load between half the steps.
Choose what repo owner? T3. GGG. Cool. Description. Some random description.
Cool. Oh, wait. I typed option delete. Oh, nope. I have to do the whole thing
again. Can you tell that I do this multiple times a week? The CLI is [ __ ]
terrible. It's so bad. And even if you happen to hit all the ideal cases. Oh, I
didn't even do anything that time. I just pressed enter and I got an unexpected
sequence. Couldn't I have just backspace instead of option backspace? If I
remember to, if I remember that the way I type normally, which is like this, and
then I do option delete to delete the last word. I'm sorry. I don't want to use
my keyboard differently because GitHub is too incompetent to let me push [ __ ]
code. I'm sorry I'm crashing out, but you guys make the stupidest [ __ ]
suggestions when your products don't work. I was just giving an example that I
personally went through two days ago. That's all. Let's try again. Push. Enter.
Enter. Enter. Some description. Enter. Public or private? Enter. Another loading
time. Created the repo. Add a remote. I told you I want to use the existing
repo. Obviously, I want a [ __ ] remote. Yeah. What should it be called? I don't
know. the thing it's always called origin. Would I like to push the commits? No,
I just wanted to make the repo and add the origin to it so I wouldn't push the
commits. Thanks GitHub for asking. And now after 1 2 3 4 5 6 7 8 nine separate
questions it asked me with four separate stoppers for loading, I now have a repo
on GitHub. Tell me how I'm wrong, chat, because you love to tell me. I deal with
this at least once a week when I'm putting up random repos for [ __ ] It's
inexcusable how bad it is. Apparently, the bug I was hitting is six years old
and just hasn't been fixed. It doesn't handle escape sequences. They just never
fixed it. Great. Do you know how you do this on code storage? Oh, wait.
Store.create repo. Now you have a repo. One line of code. When I'm trying to
describe generational product differences, this is what I'm talking about. a CLI
with nine steps and four loading blockers versus a line of code. Do you
understand the difference? Pierre does not replace GitHub. They built the next
generation of tools for whichever builders are motivated enough to build the
next generation of GitHub. Forge Joe has pushed to create. I can just push to a
fake origin and as long as it's under my like SSH key, it will just write the
repo. I should have donated more. Oh. Oh, that means your agents can just push
freely. That's magical. Why does everyone else get this right? This video is
going very differently from how I expected. I'm not going to lie, guys. And one
more thing from Code Storage. They have two other products. They have Code
Storage, which is their infrastructure that, to be fair, is not open for anyone
to use right now. You do have to like get on a wait list and get approved. I had
to annoy them on Twitter to get approved personally. But they have two other
things you can use right now. You've probably actually seen them in a handful of
products. The first is diffs.com, their open- source and freeto use diff
rendering library. I say you might have seen this because if you use T3 code,
you've probably seen this. T3 Codes diff viewer is diffs.com because diffs.com
is awesome. Phenomenal renderer for diffs. We're actually working on porting it
to React Native right now for the T3 code react native app in the future. But
they also put out a new thing, trees.software, software, a file tree rendering
library to make it way easier to render complex file trees. They're building all
the missing primitives we need. This is why I'm hyped on PR. They tried building
the GitHub alternative. Nobody wanted to use it. I know cuz I tried and it
wasn't very good. It was just another GitHub alternative. But now they're
building best-in-class primitives. So, whoever wants to build whatever shape of
GitHub alternative in the future, they now have all the pieces they need to do
it. They are a VC back company. They raised a bunch of money. They are burning
it to build this stuff in hopes that in the future code storage might make
enough money or maybe they build something else that makes money. They're just
trying to form the like garden where the best things can grow. And I have a lot
of respect to them for that. I do see a future where they win and they win big.
We got to talk about the other two potential big winners here. Graphite and
entire. You've probably heard me talk about graphite before. There's a lot to
love about them. The next generation of code review. Graphite's focus was making
better workflows for code review stuff and they did a great job. Their diff
viewer, their hotkey layer for actually navigating poll requests properly, their
comment system, their feeds, all those things made graphite feel 10 times better
than GitHub for reviewing code. But it was built almost entirely on top of
GitHub. It was built by people who worked at Facebook before that missed stack
diffs and these better workflows for making changes to code and getting them
approved and merged. and they built graphite to try and bring those things that
worked well at Facebook over to the rest of the developer world which happened
to be on GitHub and that means they were fighting GitHub constantly. the hardest
and most complex technical challenge they have faced and I've talked to many of
the founders I'm friends with them is that building on top of the GitHub API was
help one of the boldest changes they made mid last year or so if I recall is
that they added a checkbox where you could start mirroring your repos on
graphite's infrastructure because GitHub's info was too slow and it made the
site feel awful to use. So by cloning your code they could do their own diffs
their own everything effectively and it made everything feel significantly
better and faster. So, Graphite started pulling more and more off of the GitHub
APIs and into their own world, and then they got acquired by Cursor. My
suspicion, and I'll be clear, I have no meaningful inside info here. I have
actually went out of my way to not ask. I don't want to get too excited. My
suspicion is that Cursor alongside Graphite could build a different thing that
does replace GitHub, but not by being better GitHub, about being an entirely
different way to think about your source code, think about your issues, think
about your changes, and everything else. So, graphite is well positioned here to
be a different thing from GitHub, but we'll see where it goes. Graphite made a
way better experience for me when I use GitHub and still do. And I hope that
doesn't go away cuz I still rely on them heavily for that. But their focus is
integrating with Cursor and building the next generation of development as a
whole. And that does include GitHub. So, I see a way for them to to go that
direction. We have no idea where they're going to end up. And that leaves us
with one last big bet. Entire. Entire is an interesting company. They just
announced their $60 million seed round. If you're curious how they were able to
raise so much money in a seed, one of the biggest seed rounds of all time, it's
cuz the founder Thomas was the last CEO of GitHub. And when he left, they chose
to not have a new CEO. So, GitHub no longer has a CEO, but Entire does. An
entire CEO is the guy who was running GitHub up until late last year when he
left. Another important thing to note to account for bias is that I am the
second investor in the list of investors. So I am an investor. So account for
that as we talk about it. Their first release is the entire CLI for tracking
agent context. They want to think more about how agents write code and how git
isn't necessarily the right way to preserve what happens. They say here that git
preserves what changed, but nothing about why. With agents generating hundreds
or thousands of lines per session, this context loss compounds fast. Without
shared context, agents can't collaborate effectively. They retrace steps,
duplicate reasoning, yada yada yada. They want to make more durable history that
goes alongside your code so that agents know why more directly. Entire aren't
the only company trying to rethink the relationship of git and agentic code
flows. Zed is as well. Zed is an agentic editor that has been building really
cool standards including ACP, the agent client protocol, which we use for
integrating other agents in T3 code. They're also working on Delta DB, which
uses crdts to incrementally record and synchronize changes as they happen. It's
designed to interoperate with Git, but its operation-based design supports
real-time interactions that aren't supported by Git snapshots. The point of this
is to give more context to agents on what happens and why. So, there is
meaningful exploration going into this, both complnting Git and breaking out of
Git. So, it's possible the Gen 3 GitHub alternative leaves Git entirely because
Gen 1 to Gen 2 was SVN to Git. Is Gen two to Gen 3 still get? I don't [ __ ]
know. I'm hoping so because I invested in one of the companies doing this, but
we'll see. I have no idea. I legitimately don't. But there is one thing I know
for certain about this, and this is the most heartbreaking part. There's a big
problem with leaving GitHub behind. The community. This part is legitimately
sad. When I'm on GitHub and I'm looking at a pull request, I can click on the
person's profile and see what else they work on. I can see what projects they've
built, what things they've contributed to, who they are, maybe they added their
Twitter profile, and I can click that, too. It's silly, but everything is on
GitHub. So, if you're doing any work vaguely in the open, it's there. And if I'm
looking for a repo for a project that I'm using on npm, if I have some random
package I downloaded, the source is on GitHub, the author's on GitHub, the
conversation is on GitHub, the issues are on GitHub, it's all on GitHub, and
that has been really nice. in the same way that everyone uses email and that's
really nice. There was a hellish landscape of messaging apps back in the day and
everyone just kept going back to email and occasionally IRC because those were
the standards where everything kind of was and to this day people still like
using phone numbers because of all the chat apps. We need a good home and I am
sad that the unfurling of GitHub means it no longer is going to be home. We are
already at the point where major projects are leaving and that means it is
already over. The great fracturing has begun. Some projects will go to some
weird federated [ __ ] built on top of whatever the hell's going on at Blue Sky.
Some people will go to Forgejo. Some will go to GitLab. Some will go to
self-hosted instances. They're all going to go different places. And this
consistent history where you could click one person's username and see
everything they've done for the last 20 years. That's over now. And that's the
sad reality. GitHub losing means that the one core thing we had, the one place
where you could see who someone was and what they've done in the history of that
project and its relationship to other projects. That's all over now. I hate
ending on a negative note like that, but I want to make sure we're realistic
about the experience cost we're all going to eat because of the changes. I can
no longer just ask somebody to send me their GitHub profile to know if they're
legitimate or not because their best project and their best contributions might
be somewhere else. And that went from being the exception for like three or four
projects to at this point being the rule. And I don't like that rule. And I've
already seen projects die because they chose GitLab or Bitbucket before. I don't
think it will kill the projects that choose to move, but it's going to hurt the
relationships that those maintainers get across other things. And if you think
this can be solved by importing data or building yet another layer or aggregator
on top, I hate to be the bearer of bad news. You can't tool your way through
this. You can't build a better tool that changes the fact that we all used to
live in the same home and we're all going to be going other places. Do you know
how many people have tried to build custom tools so they can stay friends with
their high school friends when they all graduate and go other places? Do you
know how many of those actually work? Never. It doesn't happen. This is a
graduation moment. This is the start of the end. And it is different. I'm sure
you still have friends from high school, but it's not the same as it was when
you were there. And that is what happened here. We are graduating. We're all
going to go our own ways. We're all going to make our own new communities. We're
all going to have our own friends. We all went to school together for 20 [ __ ]
years. And it's kind of sad that that's over. And I just wanted to take a moment
to reflect on that. So yeah, I do still hold hope that GitHub can get their [ __
] together and fix things, but I don't expect it to happen. And that's why I'm
going to be investing my cash in supporting projects like Forge Joe and Codeberg
while at the same time exploring other options and building the tools that are
needed, the foundations, the blocks that will let us build our own more stable
homes for our code and for our communities in the future. Because the ones we're
using right now, the the one we're using right now, it isn't cutting it anymore.
Again, hate to end on this note, but I want to be realistic. We are losing
something no matter where we go. And that sense of community is a thing I'm
going to miss for the rest of my development career. It already feels like it
started and I don't think we're ever going to get that back. But at the very
least, we'll have better, more stable, and reliable places to host our code in
the future. I'll be real, this hit feels more tangible than the move to AI based
coding. I'm going to miss GitHub more than I miss typing out lines of code. I
know that for a fact, and I know I'm not the only one who feels that way. So,
knowing all that, go try out Forge Joe and Codeberg. Go explore these other
options. Build some cool things on Pierre. get hyped for what's happening with
Entire and all our friends over at Graphite and all these other things. But know
we are losing something when this change happens and I will miss my time spent
on GitHub. Until next time, keep contributing.

2. GitHub is one of the most important tools I've ever used in my life. I can't
   imagine how different my life would be if I didn't start using it to publish
   my work 15 years ago. So many of the relationships I have built, so many of
   the friendships that are core to my existence, so many of the jobs I've had,
   work I've done, projects I've contributed to, and more happened on and
   started in GitHub. It is hard to imagine where anything would be in software
   without GitHub and the incredible stewardship they have shown trying to help
   the open source community grow and thrive into what it's become today. which
   is why this hurts me so much. I cannot properly put into words how
   frustrating it has been watching GitHub die. This isn't just another small
   outage happening here or there. I could not use GitHub at all yesterday for
   any of the work that I do on it. I was just trying to look at pull requests,
   which we have hundreds of open on T3 Code right now and I couldn't because
   the API that responds with that stuff just wasn't working properly and didn't
   for the entire workday. I tried at noon and I tried at 6 p.m. and it didn't
   work at either. And this is just one of the many egregious outages that has
   occurred on GitHub over the last few weeks. During a separate outage related
   to pull requests, GitHub successfully reverted random things that had merged
   prior. That's not just a small like outage where you can't load the page.
   That is a split brain problem where if you had a web hook that auto deploys
   when something merges and then it gets unmerged in GitHub, you now have a
   very, very painful debugging session ahead of you. This is insane. this is
   the one thing they should never do and it has happened now and that would be
   enough for me to reconsider everything. But when Kyle, the COO, who I've
   previously had very high regards and respect for, writes this absolute [ __ ]
   slop reply where 50% of the words are trying to downplay the severity of the
   incident. I can't be polite anymore. This isn't just another small blip in
   GitHub's history. This is the erosion of trust of one of the most important
   services holding together the software world in the open source community.
   And this is why we see people like Mitchell, the creator of Ghosty, deciding
   to leave. There is a lot to dive into here. From the severity of the
   incidents to the piss poor response that I've seen from the GitHub higher-ups
   that are responsible to the core leadership failures that led here and most
   importantly, what the [ __ ] do we do now? Where do we go? GitLab, Git Ty,
   Bitbucket, I don't know. We have a lot to dive into here. I'm going to resist
   the urge to do a cringy sponsor transition here because this is a serious
   thing, but we have bills to pay. Just forgive us. This brand is really cool.
   I'm sure I trust them a lot more than GitHub right now. And then we'll be
   right back. You've already heard about today's sponsor. It's Blacksmith.
   They're the fastest way to run your GitHub actions. And we use them a lot and
   I'm very happy with them. But I need to be real with you guys. I haven't been
   able to use them for everything, and that's been really frustrating. I want
   to use Blacksmith for all of the stuff we do. And that's why I was so sad
   that our biggest open- source project, T3 Code, couldn't work on Blacksmith.
   Keyword couldn't because as of yesterday, our build times went from 6 minutes
   and 11 seconds for the ARM build on Mac to 3 minutes and 23 seconds. And for
   the x64 builds for the handful of Intel users we still support, they went
   from 9 minutes to the same 3 minutes and 34 seconds. As you probably guessed,
   the reason is that they shipped Mac runners. You can finally do any Mac
   specific tasks you need in CI on Blacksmith instead of overpaying for way
   slower boxes from GitHub. I'm going to be so real with you guys. If they were
   to charge 2x, I would still pay for it. If they were to charge 10x, I would
   still consider it. But they actually charge 60% less than an equivalent
   GitHub runner. That is hilarious. I've yet to see a bill from these guys
   because we fall within their free tier. And since our builds are so fast,
   it's unlikely we'll even hit the minutes limit. If you've ever found yourself
   waiting for a build to finish, you are wasting your time and you're probably
   wasting money, too. Fix that now at soy.link/blacksmith. One of the best
   places to start is here. GitHub's average uptime by month. To be fair, this
   is a chart that is zero indexed on 99.5%. So in this, the worst cases they
   were going down to 99.5 where previously they were at 100. While this chart
   does show meaningful degradation in reliability, it is also worth noting that
   they probably made changes to how they're tracking their uptime and
   reliability around this time. So, I don't think this is worth overreading.
   The uptime that is trackable by their official internal stuff is very
   different from our experience using the platform and seeing how reliable it
   is. Mere here made his own alternative GitHub status page, the missing GitHub
   status page. that does a much better job of tracking how the uptime actually
   feels when basically anything is down. He tracks it as downtime instead of
   downtime per service. It's every moment was something down in this window.
   And if the answer is yes, it counts as down. And when you do it that way,
   we're down to 86.75% uptime. It's bad and it's getting worse. There isn't
   even a meme 9 in here. There's no nines. Like we're we're at nearing 85%. And
   that's just part of the hell that we're in here. like we're we're just
   getting started because the various types of regressions are egregious. So,
   we're going to start with the reliability problem because this is the thing
   pushing many over the edge. GitHub has lots of other problems. There's lots
   of user experience things they could make better. There's lots of performance
   things that are horrible. Like just navigating GitHub for a big project is
   hellish and is unpleasant at best. I wish we could focus on those. I believe
   me, I have a lot of GitHub UX crashs in me. I crashed out so hard at the
   GitHub CLI that I had to unlist the video because you guys were mad at me for
   being so harsh towards it because I think it's absolutely atrocious UX. As
   much as I want to crash out at all of those things, the reliability is the
   part that matters here. The other stuff wasn't bad enough that people would
   actually leave GitHub despite many trying. The issue here is that we can't
   trust it anymore. And there's different types of reliability issues. There is
   does this work how it did yesterday? There is does this work right now and
   there is did the work I do yesterday persist. These are three of the like
   main categories that I would file under reliability. If you click a button
   and it does a thing one day and the thing the button does changes the next
   day, it is not reliable and you'll be scared to click any button going
   forward if the behavior changes. If you go to use it and it just doesn't work
   at all in the moment, you now know that this thing is fragile and can't be
   fully trusted. And if you did work one day and it vanished the next day,
   everything you do now feels fragile. In the first category here of the way
   things work changing, GitHub has not been too bad about this. There are
   problems with like regression of performance where your poll request tab
   slowly has broken over time and their attempts to rebuild the diff view has
   made it worse, not better. For the most part, it is finally getting a little
   better. While I have had my issues with random regressions in the GitHub UX,
   they are not the focus here. This is not enough for people to really move
   away from things. Part two is where things start to get iffy. This is the
   much more traditional you can't trust the thing because it's not up. I still
   vividly remember the first time I experienced this on GitHub. I was on a trip
   to LA. If I recall, I was at VidCon in 2022. I'm pretty sure that's where I
   was. We had an outage on Ping, our video service. We had some important
   customers trying to use it for an install for a Vtubing thing in person and
   we needed to make a change to the iPad app that we had done bespoke for this
   client and the API endpoint that served them. And I got everything working. I
   tested it. I was at a friend's house who had faster internet because the
   hotel I was at just did not have good enough internet. So I went to my
   friend's place. I made the changes. I tested it all on my iPad. Everything
   was working locally. I merged and I'm using Versell. So it was supposed to
   auto deploy on merge, but GitHub had an outage. GitHub web hooks was down.
   GitHub web hooks is the most common way to integrate GitHub with other
   services for things like continuous integration and deployment. If you want
   to autodeploy on merge to main, a GitHub web hook is one of the best ways to
   do that because it will notify an external service, hey, we have code
   changes. You should deploy them and then it will deploy them. So I merged the
   changes that had the code we needed and it just didn't deploy. I went and
   complained to Verscell a whole bunch. Like, what the [ __ ] guys? We made
   these changes. I can't deploy this code. Like, what's going on? And they let
   me know that GitHub had an outage for web hooks where only some of them would
   send, some of them would cue and eventually send, and some of them would just
   never go out at all. So, they couldn't even give me an estimate as to when my
   code changes would deploy. So, I had to temporarily rip out the GitHub
   integration and do a manual deployment using the Verscell CLI with the code
   on my machine because there was no other way for me to get our deployed
   servers up to date because something as simple as GitHub doing a [ __ ]
   simple post request, a curl to another service broke entirely and it was down
   for two [ __ ] hours. And that was the moment my trust in GitHub started to
   erode. And that hurt because as I said at the start of this video, GitHub is
   really important to me. I do genuinely believe I would not be here talking to
   you guys if it wasn't for GitHub. It helped kickstart my career. It
   kickstarted my love of coding. It got me way more into seeing how other
   people built, what they were building, why they were building it, finding
   where else they are online and following them, keeping up with them, and all
   these things that I learned to value and love, like the the people who make
   the software. GitHub was the first platform that was as focused on the people
   as the software and the process too where it wasn't just for looking at the
   code. I spent very little time reading code in the code bases on GitHub. I
   spent a lot more time in the poll request tab. Spent a lot more time on the
   different people's profiles. I spent more time reading the comments and
   looking at issues and all of those things. And I had kind of just seen it as
   a thing that would always be there. One of my hotter GitHub takes is that the
   Microsoft acquisition was a net positive and that Microsoft was a really good
   steward of GitHub for a long time. One of the first things that happened when
   GitHub got bought by Microsoft is they removed the requirement that you were
   a GitHub Pro paying user to have private repositories. Previously, all your
   repos had to be public unless you were paying, then you could make them
   private. So, I've been a proud GitHub Pro user since I was in high school cuz
   I wanted to have private repos. I still maintain the subscription because
   once Microsoft bought them, I made enough money to do it and I loved GitHub
   enough to keep that. Like I have been on GitHub as long as I can [ __ ]
   remember and I kept the sub because I just wanted to keep supporting GitHub.
   I like it that much. I use it heavily. I trust it. It I trusted it. And this
   was the moment that started to change. And I I remember the like internal
   crisis I went through there cuz it at that moment GitHub felt like it felt
   like Git, not in the sense that GitHub and Git are the same thing, they're
   very much not, but in the sense that like the Git install on my machine will
   always be there no matter what. I kind of felt the same about GitHub. It
   might have its quirks. It might have its problems. It might be far from
   perfect, but it was there and it worked and I could trust it. 2022 was when
   that started to fail for me. And it has gotten much worse since. And that
   breaks my heart because I still have so many friends there. I still rely on
   it heavily. It's so important. Like if I do move on from GitHub, that is like
   a chapter in my life story of like the the moving on part. And I'm far from
   the only one who feels this way. I mentioned earlier that Mitchell, the
   creator of Vagrant, Terraform, and Ghosty, is moving on from GitHub as well.
   We'll go over this article in a bit, but I want to show you a comment he left
   on HN. Flashbang warning before we get there. I know this is ridiculously
   dramatic, but it's the truth. I actually cried writing this blog post. Tears
   hit my keyboard. I'm embarrassed to say, nobody should cry over a software as
   a service of all things, but GitHub has meant so much more to me than that.
   All laid out in the post. I have an unhealthy relationship with it. It's
   given me so much and I'm so thankful for it, but it's not what it used to be.
   I don't know. We've been discussing it on and off for months. Really started
   seriously discussing it over a couple weeks ago and made the final decision a
   few days ago. Putting metaphorical pen to paper and hitting publish made it
   so very real. I'm sure folks will make fun of me for this. It's a stupid
   thing, but I truly love GitHub and I hope they find their way. I'm with him
   on that. [ __ ] sucks. This this is not a thing I want to do. And I have been
   talking to plenty of my friends at GitHub and apologizing to them for the
   things I have to do here because the state of GitHub has regressed to a point
   that is unfathomable. Specifically, now that we have left, does it work right
   now where it has downtime sometimes and now we're in did the work I did
   yesterday persist. the fact that this is now a real risk that if you had a
   pull request where you added a database migration and some new feature to
   your product and the web hook went out deployed the change and then GitHub
   didn't persist it, the diff that you have, the commit that you have in prod
   and the hash for that commit that you have in prod doesn't [ __ ] exist
   anywhere anymore. That is unfathomable. That is truly unbelievable. That is
   no longer annoying. It's down. We're now in this uncharted territory where I
   can't trust the merge button anymore. That is a really scary button to break
   trust for. As I mentioned earlier, Tom experienced this merge issue where
   something that came in through the merge queue got deployed and then
   unmerged. And these types of bugs are impossible to debug after. Like why is
   prod different than what we have here? Let's remerge the PR and now you're
   running the same migration twice and things are breaking. It's so horrifying
   to get into states like that and having to debug split brains where one thing
   sees a different history than the other. This is the problem that Git was
   meant to solve and GitHub was going to be the place where we managed all of
   that and it can no longer be trusted. But again, and I am so sorry to my
   friends at GitHub. The crash begins now. Kyle is the chief operating officer
   at GitHub. As I said before, we've had good interactions. I wouldn't call him
   a friend. I would definitely call him an acquaintance. I would imagine that
   before this moment, if we ran into each other at an event, we'd probably go
   grab drinks after. I am sorry for what I'm about to do, Kyle. This is an
   offensive response. This is a pitiful, pathetic response to what happened
   here. The severity of the issue is so great that any attempt to downplay it
   is a slap in the [ __ ] face. Let's just read this verbatim. Wanted to
   provide more clarity about this. This being the issue where merges are being
   undone. Yesterday we had a regression in merge Q behavior. Regression in
   merge Q behavior. It's a light way of putting it where in some cases, squash
   or rebase commits were generated from the wrong base state. We are many words
   in here and thus far all we have done is downplay. Making earlier changes
   appear reverted in branch history. Appear reverted. Are you [ __ ] joking?
   2,84 poll requests out of over 4 million merged on April 23rd. Roughly 0.07%.
   Do you see how many [ __ ] things he just did there? The downtime wasn't the
   whole day. The downtime was a few hours, but he extended the window to the
   whole day so he can make the percentage sound as not severe as possible. This
   is one of the most disingenuous sentences I've ever read from a comm's person
   from a product I loved. What the [ __ ] How many words were used here to
   downplay the most severe issue GitHub has arguably ever had? We fixed the
   issue. We contacted every impacted customer and we're expanding our automated
   test coverage for merge Q operations. The team will be updating the status
   page with RCA details as well. Do you understand the severity of almost 3,000
   merges being [ __ ] reverted? Clearly you don't because you framed this as a
   peer reverted and a regression in merge Q behavior. Merge Q behavior in of
   itself is such a [ __ ] stupid way to put this to anybody saying oh this must
   be legal or comms forcing them to do things. No abs that's not how legal and
   comms teams work. I've worked with a lot of them in my career. It's not that.
   Stop assuming these things while you don't work in the industry. The comm's
   team would have told him to not post and the legal team would have said just
   post what we already have on the site. This was clearly written by Kyle and
   it is clear to me that Kyle genuinely believes this wasn't a big deal. That's
   why he started it with wanted to provide more clarity, not so sorry that this
   happened. Notice how there is no apology here. There's a whole lot of words
   downplaying, not a whole lot of words apologizing. Pathetic. Absolutely [ __
   ] pathetic. If I was CEO of GitHub, I'm sorry, Kyle. I would legitimately
   fire you over this post. This is pathetic. It's insane. Thankfully, that
   won't happen because not only am I not CEO of GitHub, there is no CEO of
   GitHub. GitHub has no leader. There is no boss of GitHub. The boss of GitHub
   is a random VP of AI stuff at Microsoft that is an infraerson that has never
   written code in their life. and the CTO and COO of GitHub. Report to some
   random person who's also in charge of Azure, also in charge of C-pilot, also
   in charge of a bunch of other [ __ ] that isn't GitHub. There is no owner for
   this [ __ ] to fall on. And as a [ __ ] CEO myself, everything falls on me.
   When things break in T3 chat, in T3 code, and any of the services we rely on
   for those things and anything that we build, it goes down to me. It doesn't
   matter who shipped the bad code or what process led to the thing not going
   how it's supposed to. In the end, it is my responsibility to fix it, address
   the problems with the users, own it, and prevent it going forward. You need a
   [ __ ] CEO and they don't have one. He raised a 60 million seed round to
   rethink what GitHub looks like. And I am an investor in it. I am hopeful. I
   think he has a chance of doing things well here. It is still far too early
   for it to make sense for almost anyone yet. It's currently just a Git
   workflow, but the future of this could be a new better GitHub type thing. But
   the CEO of GitHub isn't there anymore, and they chose when he left to not
   replace him. One more quick flashbang warning. This is the executive vice
   president at Microsoft who runs the Core AI team at Microsoft. GitHub now
   directly reports to him without a CEO. GitHub is now much less independent
   and much more part of Microsoft. His previous roles were CEO of Lace Work,
   which got acquired, and then he ended up leaving and going to Microsoft in
   October of 2024. He's also a member of the board at Atlassian. I could say a
   lot about how that makes me feel, but uh we'll avoid my temptation to do
   that, as tempting as it is. It's pretty clear this person does not
   necessarily have the right experience to run GitHub. And also, to be frank,
   his job is a lot of other things. Even if he didn't have history at
   Atlassian, he would still be a questionable pick for this role simply because
   it's not a role anymore. It's just people being forced to report to him
   directly. I'm not going to entertain the conspiracy theories that maybe he is
   doing this because he wants Bitbucket to do well, so the thing he's a bored
   of does better. I wouldn't blame you for making those conspiracies though.
   So, GitHub has no real leader. To Kyle's credit and to the CTO, who I forgot
   the name of credit, they are trying their best to step in here, but there are
   problems. First off, there's nobody that like owns the failures. There's no
   CEO to come in and be like, I clearly led things wrong. We need to rethink
   everything if this stuff is happening. If the COO or CTO do that, there's a
   good chance they just get fired. So without a CEO who isn't fireable, the
   person who can own the thing and not get punished for it, like without that
   there is no path forward. And now everyone's just running in circles. And
   when you combine this with another novel problem that exists at GitHub,
   everything starts to make even more sense. GitHub has two core teams. They
   have product and they have engineering. There's a wall between them. There is
   no overlap between product and edge. They are different teams with different
   reporting chains and different processes. When I was at Twitch, my immediate
   edge team where we were building stuff had a product manager on the team
   reporting to the same person that I was reporting to. We worked together. We
   were in half our meetings together. He was effectively just part of the team.
   When the developers went out for like a dinner together, we brought our
   product manager with us cuz he was part of our [ __ ] team. And that was at
   Twitch. It doesn't matter if he knows what framework we're using or what
   patterns we're enforcing or what our new lint rules are. He just needs to
   make sure the product's good. And generally, a good product manager is
   somebody who understands the product well. So, at a place like Twitch, a good
   product manager will be somebody who uses Twitch and watches Twitch and
   understands Twitch. A good engineer is somebody who can interact with that
   product manager in such a way to implement the things that they think will
   make the product better. So, why the [ __ ] at a company that's users are
   developers is the wall between product and edge bigger than any company I've
   worked at before? A place where there should not just be less wall. They
   should be the same thing. Product andge should be the same because the
   product is ange product. So that separation is [ __ ] nonsense. And the only
   way this can work, the only way this type of hard separation can work is if
   there is a shared point they report to. If your tree looks like this, where
   you have the top and you have two branches where you have on this side you
   have product and on the other side you have engineering. If this is how your
   company is structured, I have concerns. But I also like kind of understand
   because if you have the right leader in place to synchronize these things and
   move stuff properly, you can make that work. But again, that only works when
   you have the person at the top here, usually referred to as the CEO. What
   happens when you remove that? This is what happens. The term for this
   horrible, broken ass split is a dead company. That's the problem. They
   already had [ __ ] up company architecture. They already screwed their entire
   report hierarchy in ways that are indescribably bad. But the only way it
   could work is with a really strong leader at the top. Like if it was a weak
   leader, that would be a problem. Always be a problem in a normal scenario.
   But in scenario where there is literally nobody [ __ ] there, it's over. It's
   done. And I would love more than anything to be wrong about this. We'll go
   into that in a sec. There's a few more things I want to cover. First, I want
   to talk about a fun security incident that just happened as well. This
   happened today right before I got ready to film. I want to talk about the
   Mitchell Post. I want to talk about why all the current alternatives suck.
   So, this is what we're going to do moving forward. I'll start here. Cloud
   researcher at Whiz managed to pone GitHub today with a remote code execution
   bug that let him get access to millions of repositories belonging to other
   users and organizations on GitHub. So now we have yet another type of trust
   being eroded. And this is the problem. Like GitHub went from something so
   core that the thought of not trusting it was funny to being one of the least
   trustworthy places to leave your code because your changes can get reverted.
   The platform might just be down at any time and now rce is just randomly
   dropping. When you do a git push- o you can pass arbitrary strings when you
   make your git push. GitHub will embed those strings in an internal header and
   doesn't sanitize them. So you could break out of the headers they use
   internally for receiving your git push and then use that to execute remote
   code. To their credit, GitHub did deploy a fix the same day. But these are
   really embarrassing things to happen on a platform as important as GitHub.
   Absurd. So this hurts trust a lot, too. I'm thankful they fix it so fast.
   That helps a bit. But everything else hurts so much it cancels out almost.
   Now we need to talk about the Mitchell post. I've been hearing this one's
   emotional. It's time to talk about Ghosty leaving GitHub. This one, I'll be
   honest, kind of pushed me over the edge a bit, too. Mitchell is GitHub user
   1,299. He joined in February of 2008. That is so much more legit than me.
   It's hilarious. I was 12. Writing this makes me irrationally sad, but Ghosty
   will be leaving GitHub. I'm GitHub user 1299, joining February 2008. Since
   then, I've opened GitHub every single day. Every day, multiple times per day,
   or over 18 years, over half my life. A handful of exceptions in there. I'd
   love to see the data, but I can't imagine more than a week per year. I feel
   that so hard. I am at about 15 years or so, I think. So, yeah, GitHub is a
   thing I am very almost like intimately familiar with. The amount of time I've
   spent on there is insane. GitHub is the place that has made me the most
   happy. I always made time for it. When I went through tough breakups, I lost
   myself an open source on GitHub. During college at 4 a.m. when everyone's
   passed out, let me get one quick commit in during my honeymoon while my wife
   is still asleep. Yep, GitHub. It's where I've historically been happiest and
   where I've wanted to be. Even the annoying stuff. Some people doom scroll
   social media. I've been doomcrolling GitHub issues since before that was a
   word. On vacations, I'd have bookmarks of different projects on GitHub that I
   wanted to study. Not just the source code, but the open source processes, how
   the other maintainers react to difficult situations, etc. Believe it or not,
   I like this. I believe it because I did the same. A big part of my success
   personally came from reading through how pull requests got responded to,
   reviewed, and merged, looking at how issues were triaged, and all these other
   things like seeing the people who do the work, which is really what made
   GitHub magical. It wasn't just the source, it was the people editing the
   source and making the software great. And I got to see that before I knew
   what any of that meant. It was magical. And if you're not into that, it's
   fine. But for those of us who are, this is heartbreaking. Some might call
   this sick, but my hobby and work and passion all align. And for most of my
   life, they got to also live in one place on the internet, GitHub. Did you
   know that he started Vagrant, which was his first successful open source
   project in large part because he hoped it would get him a job at GitHub. I
   don't think this was public info before, that the reason he made Vagrant is
   that he wanted to work at GitHub. It's no secret. He said this repeatedly.
   Oh, actually he did say this before. In his first talk about Vagrant when he
   was only 20, he joked, "Maybe GitHub will hire me if it's good." GitHub was
   my dream job. I didn't ever get to work there. Not their fault, but it was
   the perfect place that I wanted to be. The engineers were incredible, product
   was incredible, and it was something I lived and breathed every day. I still
   do and consistently have for these 18 years. Enough time for an entire human
   to become an adult, all spent on GitHub. Lately, I've been very publicly
   critical of GitHub. I've been mean about it. I've been angry about it. I've
   hurt people's feelings. I've been lashing out because GitHub is failing me
   every single day and it's personal. It is irrationally personal. I love
   GitHub more than a person should love a thing and I'm mad about it. I'm sorry
   about the hurt feelings to the people who are working on it. I felt this way
   for a long time. For the past month, I've kept a journal where I put an X
   next to every day where a GitHub outage has negatively impacted my ability to
   work. Almost every single day has an X. On the day I am writing this post, I
   have been unable to do any PR reviews for over two hours because there's a
   GitHub actions outage. This is no longer a place for serious work if it just
   blocks you out for hours per day every day. It's not a fun place for me to be
   anymore. I wanted to be there, but it doesn't want me to be there. I wanted
   to get work done and doesn't want me to get work done. I want to ship
   software and it doesn't want me to ship software. I want it to be better, but
   I also want to code and I can't code with GitHub anymore. I'm sorry. After 18
   years, I've got to go. I'd love to come back one day, but this will have to
   be predicated on real results and improvements, not more words and promises.
   I'll share more details about where the Ghosty project will be moving to in
   the coming months. We have a plan, but I'm also very much still in discussion
   with multiple providers, both commercial and open source. It'll take us time
   to remove all our dependencies on GitHub, and we have a plan in place to do
   it as incrementally as possible. We plan on keeping a readonly mirror
   available on GitHub at the current URL. My personal projects and other work
   will remain on GitHub for now. Ghosty is where I, our maintainers, and our
   open source community are most impacted. So, that is the focus of this
   change. We'll see where it goes after that. This [ __ ] sucks. Like, I don't
   know what else to say here. I know a lot of y'all see me as an influencer,
   but like, I remember the moment that that shifted. Up until around 100,000
   subs, I was the open- source guy who happened to have a YouTube channel. And
   since then, I'm the YouTuber that pretends he does software dev. I get why
   people think that. Whatever. I'm not going to be mad at you for it. But
   GitHub is my original YouTube. GitHub is the platform I obsessed over every
   detail of the platform that I built everything I am on. I wouldn't be here if
   it wasn't for that. I got my first jobs because I had somewhat impressive
   projects on GitHub. They weren't even that impressive, but they were there
   and it was proof. And watching it die, going to GitHub and feeling that like
   fear and frustration, wondering what's going to break this time. And I was
   genuinely in disbelief when I went to the poll request tab yesterday to look
   at some PRs that I had heard Julius mention to just not have it load at all.
   And I went back two hours later and it still wasn't loading. It's insane.
   It's genuinely absurd. And I will be real. If you think we're overreacting, I
   am thankful I've never had to work with you because you don't actually care
   about software. Like every maintainer I know of real software is beat up [ __
   ] hard about this one. And I understand my friends at GitHub's initial
   reaction being upset with us for going so hard, but it's my responsibility to
   the reason I have this channel is so I could fight for open source
   maintainers. That was like the goal from the start. I wanted to bring back
   the convos I missed from lunch and dinner and advocate for the awesome things
   happening in the open source developer world. And every one of those
   maintainers that made me the dev I am today is suffering because of GitHub's
   inane [ __ ] Even just [ __ ] today, Tanner Lindsley hit me up. If you're not
   familiar with Tanner, he's the creator of Tanstack, which is an ecosystem of
   tools that make web development significantly better. Tanner was failed hard
   by GitHub today because they've been failing him for a long time because
   GitHub owns npm. npm is how we install packages in the JavaScript world.
   Tanstack is his org. So, he has tanstack slash, but somebody else squatted on
   the Tanstack package. He has been reporting this to NPM for months now. Hell,
   I think it's been years. He tried going the trademark route. He tried going
   the internal contacts route. He tried going every other route he could. And
   npm did not budge. They did not do anything about it. They just ghosted him.
   You know what happened today? Seemingly legitimate packaged handstack seems
   to have been compromised with a post install script that steals yourv files
   and xfiltrates them to a remote host. That is not a seemingly legit package.
   That is a name squat. And because GitHub didn't take the report seriously,
   there is real malware being shipped under the Tanstack name. This has been
   verified by socket because remember it's not a legit package. It's not
   associated with them at all. They don't own that. They don't own the name.
   They don't own anything. They should. And since GitHub and npm chose to not
   help an open source maintainer working in perfectly good faith, people are
   now getting pawned. Their irresponsibility isn't just inconvenient or nice
   optics things. Like obviously Tanner wanted the Tanstack package. Of course
   he does. I wanted the T3 package. Like spent money and got it. Despite all of
   that, the legitimate safety risk of this package not being owned by a real
   maintainer was entirely ignored. And now malware is being shipped under
   Tanner's [ __ ] name because GitHub is so incompetent. Not only does GitHub
   not care about open source maintainers anymore, they're actively hurting
   them. And open source maintainers already have to work so hard and so
   thanklessly. GitHub sold to Microsoft for billions of dollars on the backs of
   these open source maintainers and has just slowly let them suffer since. It's
   pathetic. It's inexcusable. The maintainer who is name squatting demanded
   $10,000 from Tanner. Clearly a malicious actor and npm's done nothing.
   GitHub's done nothing. Microsoft's done [ __ ] nothing. There is no excuse
   for this. We are past the point. And to go back to where we started here,
   we're talking about the different types of reliability. I'm going to add one
   more layer. There's four tiers here of reliability problems. The first is,
   does it work the way it did before? GitHub's been failing that for a while.
   People didn't care. Next is, does it work right now? GitHub has slowly been
   falling apart and now it's barely usable, but that wasn't enough for people
   to care. Did the work I do yesterday persist? Cannot believe they have now
   passed this line. that you cannot know for sure when you merge a PR that it
   stays merged. And now we're at the last level here. Can others steal my work
   and harm my users? They are failing here, too. In all of the ways a platform
   can lose trust, GitHub has lost it. In every way that we can rely on a
   platform, we can't rely on GitHub anymore. And as much as I want to talk
   about where we can go next, this video is already long enough. So, let me
   know in the comments what your favorite GitHub alternative is, and I'll be
   sure to consider it in a very fun, likely similarly long follow-up video
   about all the alternatives to GitHub that we should explore. And I'm sorry to
   all my friends at GitHub for this video. I um I I've been debating doing this
   for over a year now. I was debating this when we were just here, when we were
   at level two of these four levels. I was on the line about doing this, and I
   chose not to because I trusted y'all, and I still trust y'all. I want to be
   wrong about this. I want to see real change happen. I want to see a leader
   appointed. I want to see the product and edge teams at GitHub merge. I want
   to see a real road map with real promises to solve these real problems. And I
   want to know you guys are going to fix it. And then I want to see it fixed.
   But it would be irresponsible of me to not make this video. I would be
   failing the reasons I started the channel. I'd be failing my friends in the
   open source world. I'd be failing my own moral code if I didn't. This is
   beyond unacceptable. Things need to change. And as much as Microsoft was a
   decent steward of GitHub for the first few years, it's clear they no longer
   are. Something severe needs to change, and I don't see it happening right
   now. And in this moment, I can no longer trust or even recommend GitHub. I
   don't know. I I have no idea what to even end this on. I'm genuinely beat up
   by this one. I hate that we're at this point. I really do. And I am so sorry
   to my friends there. Please fix this. You don't have one more chance. You are
   in debt of chances. But if I go back to GitHub in the future and it is
   working better, I'll feel better a bit. But this is no longer like make it
   right or promise us you'll make it right. This is we're past the point now.
   From my friends having their names used to hack people and steal their
   environment variables and credentials to things being reverted randomly to
   not knowing if I can even see the work my team is doing. It's over there.
   There's nothing to repair. When there is zero trust, you can't repair trust.
   There's no foundation to build on anymore because you [ __ ] the whole thing
   up. It's over. You killed your platform and there's nothing that I think can
   be done. I would love for you to prove me wrong, but until then, I'm going to
   go very, very hard evaluating alternatives. Until next time, hopefully your
   code merges.
