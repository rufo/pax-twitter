require.paths.unshift(__dirname + '/node_modules/express/support');
var sys = require('sys'),
  fs = require('fs'),
  http = require('http'),
  io = require('socket.io'),
  express = require('express'),
  TwitterNode = require('twitter-node/lib/twitter-node').TwitterNode;

var config = JSON.parse(fs.readFileSync("config.json", 'ascii'));

var twitter_client = http.createClient(80, "api.twitter.com");
  
var followed_user_tweets = {},
  followed_keyword_tweets = {};

fs.readFile("cache.json", function(err, data) {
  if (err) {
    console.log('Your cache file could not be found or could not be read. Your data will not be persisted.');
  }
  else {
    var cacheData = {};

    try {
      cacheData = JSON.parse(data.toString('ascii'));
    } catch (e) {
      console.log('Your cache file is not valid JSON. Could not recover any data.');
    }
    followed_user_tweets = cacheData.followed_user_tweets || {};
    followed_keyword_tweets = cacheData.followed_keyword_tweets || {};

    setInterval(function () {
      var cache = {
        followed_user_tweets: followed_user_tweets,
        followed_keyword_tweets: followed_keyword_tweets
      };
      fs.writeFile('cache.json', JSON.stringify(cache), function (err) {});
    }, 10000);
  }
});

var screen_names_to_lookup = []

for (var user_index in config.follow_users) {
  var user = config.follow_users[user_index] + ""
  if (user.substr(0,1) == "@") {
    screen_names_to_lookup.push({str: user.substr(1), index: user_index});    
  }
}

var num_screen_names_left = screen_names_to_lookup.length;

screen_names_to_lookup.forEach(function(screen_name){
  var req = twitter_client.request('GET', '/users/show.json?screen_name=' + encodeURIComponent(screen_name.str), {'host': 'api.twitter.com'});
  req.on('response', function(response) {
    if (response.statusCode == 200) {
      var body = "";
      response.setEncoding("utf8");
      response.on("data", function(chunk) {
        body += chunk;
      });
      response.on("end", function() {
        var user_info = JSON.parse(body);
        try {
          console.log("Replacing @" + screen_name.str + " with user id " + user_info.id)
          config.follow_users[screen_name.index] = user_info.id
          num_screen_names_left--;
          if (num_screen_names_left == 0) {
            startStreaming();
          }
        } catch (err) {
          console.log(sys.inspect(err));
        }
      });
    } else {
      console.log("Failed to get user id for @" + screen_name.str);
    }
  });
  req.end();
});

function formatMessage(type, payload) {
  return JSON.stringify({
    type: type,
    data: payload
  })
}

function broadcastData(type, payload) {
  io.broadcast(formatMessage(type, payload));
}

function sendData(conn, type, payload) {
  conn.send(formatMessage(type, payload));
}

var app = express.createServer();

app.configure(function() {
  app.use(express.staticProvider(__dirname + '/public'));
});

app.get('/', function(req, res){
  res.redirect('index.html');
});

app.listen(config.listen_port);

var io = io.listen(app);

io.on('connection', function(client) {
  for(var j in config.follow_users) {
    var user = config.follow_users[j];
    if (!(typeof followed_user_tweets[user] === "undefined")) {
      for(var i = followed_user_tweets[user].length - 1; i >= 0; i--) {
        sendData(client, 'user', {
          user: user,
          tweet: followed_user_tweets[user][i]
        });
      }
    }
  }
  for(var j in config.follow_keywords) {
    var keyword = config.follow_keywords[j];
    if (!(typeof followed_keyword_tweets[keyword] === "undefined")) {
      for(var i = followed_keyword_tweets[keyword].length - 1; i >= 0; i--) {
        sendData(client, 'keyword', {
          keyword: keyword,
          tweet: followed_keyword_tweets[keyword][i]
        });
      }
    }
  }
});

function inArray(arr, value) {
  for(var i=0; i<arr.length; i++) {
    if (arr[i] == value)
      return true;
  }
  return false;
}

function idInArray(arr, value) {
  for(var i=0; i<arr.length; i++) {
    if (arr[i].id == value)
      return true;
  }
  return false;
}

function addToCache(arr, value) {
  if (arr.unshift(value) > 25) {
    arr.splice(25, arr.length - 25);
  }
}

function deleteFromCaches(id_str) {
  for (var i in followed_user_tweets) {
    followed_user_tweets[i] = followed_user_tweets[i].filter(function(tweet){
      return (tweet.id_str != id_str); // return false (ie, filter out) if id_str matches
    });
  }

  for (var i in followed_keyword_tweets) {
    followed_keyword_tweets[i] = followed_keyword_tweets[i].filter(function(tweet){
      return (tweet.id_str != id_str); // return false (ie, filter out) if id_str matches
    });
  }
}

function deleteTweet(tweet) {
  deleteFromCaches(tweet.id_str);
  broadcastData('delete', {id_str: tweet.id_str});
}

function receivedTweet(tweet) {
  if(inArray(config.follow_users, tweet.user.id)) {
    followed_user_tweets[tweet.user.id] = followed_user_tweets[tweet.user.id] || [];
    addToCache(followed_user_tweets[tweet.user.id], tweet);
    broadcastData('user', {
      user: tweet.user.id,
      tweet: tweet
    });
  }
  for(var i in config.follow_keywords) {
    var keyword = config.follow_keywords[i];
    var pattern = new RegExp(keyword, "i");
    if (pattern.test(tweet.text)) {
      followed_keyword_tweets[keyword] = followed_keyword_tweets[keyword] || [];
      addToCache(followed_keyword_tweets[keyword], tweet);
      broadcastData('keyword', {
        keyword: keyword,
        tweet: tweet
      });
    }
  }
}

function primeCache() {
  for (var i in config.follow_users) {
    (function() {
      var user = config.follow_users[i];
      console.log("Queueing cache prime for " + user);
      setTimeout(function() {
        console.log("Executing cache prime for " + user);
        var req = twitter_client.request('GET', '/statuses/user_timeline/' + user + '.json', {'host': 'api.twitter.com'});
        req.on('response', function(response) {
          if (response.statusCode == 200) {
            var body = "";
            response.setEncoding("utf8");
            response.on("data", function(chunk) {
              body += chunk;
            });
            response.on("end", function() {
              try {
                var timeline = JSON.parse(body);
                timeline.sort(function(a,b) {
                  return a.id - b.id;
                });

                var low_id = 0;
                followed_user_tweets[user] = followed_user_tweets[user] || []
                if (followed_user_tweets[user].length > 0)
                  low_id = followed_user_tweets[user][followed_user_tweets[user].length-1].id;
                for(var j in timeline) {
                  if(!idInArray(followed_user_tweets[user], timeline[j].id) && timeline[j].id > low_id) {
                    receivedTweet(timeline[j]);
                  }
                } 
              } catch (err) {
                console.log(sys.inspect(err));
              }
            });
          } else {
            console.log("Failed to collect status for " + user);
          }
        });
        req.end();
      }, 1000 * i);
    })();
  }
}

var pax_tweets;

if ((screen_names_to_lookup.length == 0) && (typeof pax_tweets == "undefined")) {
  startStreaming();
}

function startStreaming() {
  console.log("starting twitter streaming");
  
  pax_tweets = new TwitterNode({
    user: config.username,
    password: config.password,
    track: config.follow_keywords,
    follow: config.follow_users
  });

  pax_tweets.addListener('tweet', function(tweet) {
    receivedTweet(tweet);
  });

  pax_tweets.addListener('delete', function(tweet){
    deleteTweet(tweet.status);
  })

  pax_tweets.addListener('end', function(statusCode) {
    console.log("Stream Closed with " + sys.inspect(statusCode));
    setTimeout(pax_tweets.stream, 5000);
  });

  pax_tweets.addListener('error', function(err) {
    console.log(sys.inspect(err));
  });
  
  primeCache();
  pax_tweets.stream();
}
